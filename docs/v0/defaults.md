# 临时默认值

实现时需要一个值、但还没有经过你确认的地方都登记在这里。每一项都是"临时默认值"，拿到依据后再定。

| 默认值 | 取值 | 位置 | 理由 | 何时复查 |
| --- | --- | --- | --- | --- |
| 连接表单的上下文长度 | 128000 | `app/src/renderer/src/components/ConnectionForm.tsx` `emptyForm` | 与 pi 的默认值相同 | 拿到内网端点时 |
| 测试连接的最大输出 | 512 token | `app/src/kernel/config.ts` `TEST_MAX_TOKENS` | 推理模型先输出思考，太小时只收到思考、没有正文 | 拿到内网端点时 |
| 测试连接的超时 | 30 秒 | `app/src/kernel/config.ts` `TEST_TIMEOUT_MS` | 端点接受连接却不回复时，按钮不至于一直处于"测试中" | 拿到内网端点时 |
| 测试连接的提示词 | `Reply with one short sentence.` | `app/src/kernel/config.ts` `testConnection` | 短、任何模型都能回答；M1 用 DeepSeek 两个模型都正常 | 拿到内网端点时 |
| Mori 在 `models.json` 中的 provider id | `models.json` 里还没有 Mori 的连接时用 `mori-endpoint`（M0 起沿用）；否则用 `mori-endpoint-<毫秒时间戳>`（已被占用时加一）。删掉的 id 不再用 | `app/src/kernel/config.ts` `nextProviderId` | 与 pi 内置 provider 不冲突，一个连接下可以有多个模型。不重用：pi 按 provider id 找 key 和模型，会话文件记的是 `provider/模型`，重用删掉的 id 会让打开着的会话和重新打开的旧会话悄悄连到新的端点（M6 复查发现）；时间戳不用另存"用过的最大编号" | 你想给连接起有意义的 id 时 |
| 打开信任询问之前按不信任创建 | `projectTrusted: false`，pi 在加载项目资源前调用 `resolveProjectTrust` 再定 | `app/src/kernel/sessions.ts` `loadResources` | 与 pi 自己的 `loadProjectTrustExtensions` 相同；M3 起接上信任询问（见 [screens/sessions.md](screens/sessions.md)） | — |
| 文件夹没有要信任的内容时直接按信任处理、不问 | `resolveProjectTrust` 返回 true | `app/src/kernel/trust.ts` `decideTrust` | 与 pi 命令行相同；这时没有项目资源可加载 | — （M6 已复查：工具页每次重新判断，见"工具页对'没有要信任的内容'的文件夹重新判断"） |
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
| 草稿存放 | 本机 `localStorage`：文字在 `mori.drafts`，引用芯片在 `mori.draftRefs`（M4），都按会话文件；不按会话列表清理 | `app/src/renderer/src/state/drafts.ts` | 方案第 6 节"界面状态（……各会话草稿）"；pi 读不出会话目录时列表为空，按它清理会误删全部草稿；芯片另存一个键，M3 存下的文字草稿不用转换 | 你走查时 |
| 退出时等后台进程释放会话 | 3 秒 | `app/src/main/kernel-process.ts` `SHUTDOWN_TIMEOUT_MS` | 超时后直接结束后台进程的作业（后台进程和它启动的所有进程）；M1 没有发现需要调整的情况 | M6 |
| 兼容选项列表 | 端点不支持 developer 角色（`supportsDeveloperRole: false`）、不接受 store（`supportsStore: false`）、最大输出用 `max_tokens`（`maxTokensField`）、不支持流式用量（`supportsUsageInStreaming: false`）、不支持 strict 模式（`supportsStrictMode: false`）、工具结果需要带工具名（`requiresToolResultName: true`） | `app/src/shared/protocol.ts` `COMPAT_OPTIONS` | 方案 5.2 要求每项配中文说明；挑的是 OpenAI 兼容端点最常见的几处差异，与思考有关的（需要 `reasoning: true` 才生效）留到 M6 | 拿到内网端点时 |
| 错误卡附"去设置"的文字匹配 | 原文含 `401`、`unauthorized` 或 `api key`（不区分大小写） | `app/src/renderer/src/components/Transcript.tsx` `SETTINGS_HINT` | 方案 5.8；其他错误附"把上一条消息放回输入框" | 拿到内网端点的错误原文时 |
| 从会话记录载入时识别"你按过停止" | 工具结果以 `Command aborted` / `Operation aborted` 结尾，或回复的错误原文以 `This operation was aborted` / `Request was aborted` / `Operation aborted` 开头 | `app/src/renderer/src/state/history.ts` `ABORTED_TOOL`、`ABORTED_REPLY` | 实时运行时按你按了停止判断；pi 的会话记录里没有"被停止"的标记，停止后的回复记为 `stopReason: error`，只能看原文 | pi 升级时复查原文 |
| 工具卡展开后输出最多显示 | 最后 20,000 字 | `app/src/renderer/src/components/ToolCard.tsx` `OUTPUT_MAX` | 避免超长输出卡住渲染；pi 的命令输出本身已截到 50KB 左右；M4 的文件阅读器只看文件，不改这里 | 你走查时 |
| "在底部"的判定 | 离底部不超过 24px | `app/src/renderer/src/components/Transcript.tsx` `BOTTOM_SLACK` | 小于一行字，滚轮停在差几像素处也算在底部 | 你走查时觉得跟随不对再调 |
| 输入框最高 | 220px，之后在框内滚动 | `app/src/renderer/src/components/Composer.tsx` `MAX_INPUT_HEIGHT` | 约 9 行；再高会挤掉对话流 | 同上 |
| 一条回复里的多个工具调用按顺序执行 | pi 的 `toolExecution: "sequential"`（pi 默认是 `parallel`） | `app/src/kernel/sessions.ts` `startSession` | pi 默认并行时，一条回复里的调用先逐个经过批准处理器，全部放行后才一起执行：允许第一张卡后它并不马上执行，要等后面的卡也答复，而且多条命令会同时运行。按顺序执行时允许一张就执行一张，你看到上一条的结果再决定下一张（方案 5.7"逐张出卡"） | M2 签收时请你确认；只读工具多时可能变慢 |
| 停止时等 pi 记下拒绝的上限 | 2 秒 | `app/src/kernel/approval.ts` `STOP_SETTLE_MS` | 有挂着的卡时按停止，先拒绝、等这次调用在 pi 里结束再中止；先中止的话 pi 只记"Operation aborted"，重新打开会话就认不出"已拒绝"。正常不到 10 毫秒就结束，超时后照样中止 | 你走查时停止变慢再调 |
| 工具卡上拒绝理由显示的长度 | 40 字，超出部分用"…"，悬停看全文 | `app/src/renderer/src/components/ToolCard.tsx` | 长理由会挤掉工具卡的标题；展开工具卡能看到完整理由 | 你走查时觉得不够再调 |
| 拒绝时回给模型的工具结果 | `Rejected by the user.`；写了理由时 `Rejected by the user. Reason: <理由>`；你按了停止时 `Rejected: the user stopped the run.` | `app/src/shared/protocol.ts` `REJECTED_*` | pi 把扩展给的 reason 原样作为工具结果；固定写法让模型明白是你拒绝的，从会话记录载入时也能据此显示"已拒绝" | 内网模型对英文提示的理解不好时 |
| 界面问题报告的保存位置 | `<userData>/ui-issues/<YYYY-MM-DD-HHmmss>.md` 和同名 `.png` | `app/src/main/feedback.ts` | 一个文件夹里平铺，"打开所在文件夹"就能看到全部报告；M7 的收件箱读同一个文件夹 | M7 |
| 界面问题报告里"最近的操作"的条数 | 30 条（只在本次运行的内存里） | `app/src/renderer/src/state/actionLog.ts` `ACTION_LOG_SIZE` | 够看清出问题前做了什么，文件不会太长 | 你用 F8 时觉得不够再调 |
| 右栏在出现改动时自动打开 | 本会话第一次有编辑或写入结果时打开；你手动开关之后以你为准 | `app/src/renderer/src/App.tsx` `Workspace` | 方案 5.9 只说"没有改动时默认收起"，有改动时按"默认打开"理解；M4 沿用 | 你走查时 |
| 发给模型的引用块 | 每个芯片一段："引用 <路径> 第 a–b 行："（回复里的是"引用你之前的回复："），下面每行原文前加 `> `，段之间空一行，之后空一行接你的文字 | `app/src/renderer/src/state/quotes.ts` `quoteBlock`、`composePrompt` | 模型要看到原文才能回答；Markdown 引用格式各家模型都认识；显示时按同一格式认出引用块、只在气泡里留你写的字 | 内网模型对引用的理解不好时 |
| 对内容的反馈保存位置 | `<userData>/feedback/<YYYY-MM-DD-HHmmss>.json`，每份一个文件 | `app/src/main/feedback.ts` `feedbackDir` | 与 F8 的报告放在同一个数据目录下；JSON 带锚点，M7 的工作回顾读同一个文件夹 | M7 |
| 阅读器语法高亮的上限 | 不超过 200KB 的文件按扩展名高亮，更大的只显示原文 | `app/src/renderer/src/components/FileViewer.tsx` `HIGHLIGHT_MAX` | 你要求不拿内存和 CPU 换性能（2026-10-20）；高亮的缓存由 @streamdown/code 自己限量 | 你走查时觉得慢再调 |
| 判断二进制文件 | 开头 8000 字节里有 0 字节 | `app/src/main/files.ts` `BINARY_PROBE_BYTES` | 与 git 的做法相同 | 遇到误判时 |
| "用系统编辑器打开"时当作会被运行的文件 | 扩展名在 `PATHEXT` 里，或是 .com .exe .bat .cmd .vbs .vbe .js .jse .wsf .wsh .msc .ps1 .psm1 .py .pyw .lnk .url .hta .msi .msp .scr .cpl .reg .jar .appref-ms .application .website .settingcontent-ms；这些改为在资源管理器里选中 | `app/src/main/files.ts` `RUNNABLE` | Windows 的"打开"对这类文件就是运行，文件可能是模型刚写的；Electron 没有"编辑"动作 | 你觉得哪类文件该能直接打开时 |
| 在文件里找引用的原文 | 最多看 1000 处出现的地方，取离原来的行最近的一处 | `app/src/renderer/src/state/quotes.ts` `SEARCH_MAX` | 很短的原文在大文件里会出现很多次，不让一次点击无限地搜下去 | 你走查时 |
| 几个提示停留的时间 | 回到原位置的高亮约 4 秒；"已记录"约 3 秒后关闭表单；"已复制"约 2 秒 | `quoteHighlight.ts` `HIGHLIGHT_MS`、`FeedbackForm.tsx` `SAVED_MS`、`ReplyActions.tsx` `COPIED_MS` | 看得见、又不一直挡着 | 你走查时 |
| 会话引用的默认范围 | 全部已完成的轮次；全部超过 20,000 字时最近 5 轮 | `app/src/renderer/src/state/sessionRefs.ts` `REF_FULL_LIMIT`、`REF_RECENT_TURNS` | 方案 5.11 定的临时默认值；字数按引用内容的字符数（含"第 N 轮"标题） | 你走查时；内网模型上下文较小时 |
| 会话引用的内容格式 | 每轮以"第 N 轮"开头，你的消息写"用户："、助手的正文写"助手："，工具调用一行"[工具] 工具卡标题"，你的消息里的引用一行"[引用] 来源"；轮之间空一行。发给模型的引用块第一行"引用会话“会话名”第 a–b 轮："，内容每行前加 `> ` | `app/src/renderer/src/state/sessionRefs.ts` `sessionTurns`、`app/src/renderer/src/state/quoteText.ts` `quoteBlock` | 内容要给另一个模型读，用"用户 / 助手"比界面上的"你"清楚；与 M4 的引用块同一种拼法 | 内网模型对引用的理解不好时 |
| 芯片上的"约 X 字" | 1,000 以上取整到百，100–999 取整到十，100 以下照实 | `app/src/renderer/src/state/quoteText.ts` `approxChars` | 方案的例子是"约 3,200 字" | 你走查时 |
| 分屏的初始比例 | 两栏各一半；拖动后的比例存在本机（`localStorage` 的 `mori.layout`，`split`），重启后保留 | `app/src/renderer/src/state/layout.ts` | 与 demo/resize.js 相同 | 你走查时 |
| 分屏时右栏放得下的条件 | 中栏放得下两栏各 280px 加右栏最窄的 260px；放不下时右栏先收起，点开关才浮在上层 | `app/src/renderer/src/App.tsx` `useColumns`、`RIGHT_MIN` | 方案 5.11"两栏各不足 280px 时先收起右栏"；260px 是右栏原有的最小宽度 | 你走查时觉得两栏太挤再调 |
| 重启后不恢复分屏 | 只保留分屏的比例；哪两个会话在分屏里不保存 | `app/src/renderer/src/state/store.ts` `split` | M3 起启动后不自动打开任何会话（照 Claude 桌面版），分屏也一样 | 你走查时 |
| 打开或切换会话后把焦点放进输入框时等菜单退出的帧数 | 最多 5 帧，仍有浮层（例如信任询问）就不动焦点 | `app/src/renderer/src/state/split.ts` `FOCUS_RETRY_FRAMES` | 菜单关闭后它在浮层栈里的登记要到下一次提交之后才去掉 | — |
| 生成中不能换模型和思考强度 | 顶栏的两个按钮在本轮运行中（含"刚发出"）不可用，后台进程也拒绝 | `ModelMenu.tsx`、`ThinkingMenu.tsx`；`app/src/kernel/sessions.ts` `requireIdle` | pi 允许运行中换，下一次请求才用新的；界面上不清楚这一轮到底用的哪个，先不允许 | 你走查时觉得要能在生成中切换 |
| 顶栏在窄栏里怎样收紧 | 按会话面板宽度分步，单栏、分屏相同，模型和思考按钮任何宽度都在：≤ 720px 权限按钮去掉图标、模型按钮最长 120px；≤ 600px 不显示项目名（分屏 ≤ 640px 起）、思考按钮只显示强度（"高 ▾"）、模型、思考和权限菜单贴着面板右边打开；≤ 480px 不显示上下文用量；≤ 400px 模型和思考按钮去掉 ▾、间距收小；再放不下时模型按钮收短，最窄 40px（先截模型 ID，"（已删除）"最后截），会话名至少留 36px。收起的文字在悬停说明和读屏名称里（models.md"窄栏"） | `app/src/renderer/src/styles/chat.css`、`models.css`、`split.css` 的 `@container` | 最窄的两种：分屏每栏 280px，M1 的 800 宽、右栏打开时中栏 300px；阈值按最宽的文字估算（"思考：不可选"、"全部允许"、"上下文 100%"、"<ID>（已删除）"）。上下文用量只是显示，先让给能操作的按钮 | 你走查时觉得窄栏里哪一项该留、哪一项该收 |
| 不支持思考的模型的思考菜单 | 列出关–高（pi 对支持思考、没有映射的模型给出的那一组），全部不可用，没有打勾的 | `ThinkingMenu.tsx` | 让你看到标了"支持思考"以后能选什么；方案只要求"不可选"并说明原因 | 你走查时 |
| 新模型的上下文长度 | 128000（与连接表单相同） | `ConnectionForm.tsx` `emptyModel` | 与 pi 的默认值相同 | 拿到内网端点时 |
| MCP 服务的错误原文怎样找 | 跟随的会话对话流里以 `MCP ` 开头的扩展通知，取其中以 `<服务名>:` 开头的行；完整通知可以展开 | `app/src/renderer/src/state/tools.ts` `mcpNotices` / `serverLines` | pi 只经通知报告连接错误（`MCP servers need attention:` 每个服务一行），没有结构化的状态；按 pi 的原文格式认行 | pi 升级时复查原文格式 |
| 技能正文在工具页最多显示 | 20,000 字 | `app/src/kernel/resources.ts` `BODY_LIMIT` | 技能一般很短；不让一个很大的 SKILL.md 撑大工具页 | 你走查时 |
| "/"补全的排序 | 名字以你打的字开头的在前，包含它的在后，不分大小写；分"提示词模板""技能"两组 | `app/src/renderer/src/state/slash.ts` `filterCommands` | 照 Claude 桌面版的命令列表随打字过滤；pi 终端用模糊匹配 | 你走查时觉得找不到再调 |
| `mcp.json` 写入的格式 | 两个空格缩进，末尾换行；只改那一个服务，其他内容和顺序不变 | `app/src/kernel/mcpConfig.ts` | pi 自己改 `mcp.json` 时保留原来的缩进；Mori 写的与 pi 读到的内容相同，只是缩进可能变 | 你介意格式变化时 |
| "启用整个包"的写法 | 把这个包在设置里写回只有来源的字符串（去掉全部过滤，单独停用过的资源也一起启用） | `app/src/kernel/resources.ts` `setPackageEnabled` | pi 文档里"全部加载"就是字符串写法；`pi config` 没有整包启停 | 你走查时 |
| 离开有未保存改动的页面时先问 | 只问用户级 AGENTS.md 的编辑框；连接、模型、MCP 表单没保存就离开时不问；关闭 Mori 窗口不问 | `app/src/renderer/src/state/leaveGuard.ts` | 方案 5.12 只对 AGENTS.md 有要求；表单都很短 | 你走查时 |
| 工具页、设置页的改动何时生效 | 启停、添加、AGENTS.md 都只对之后新建的会话生效，界面上明说；模型和连接的改动对打开着的会话立刻生效（后台进程换模型对象） | `ToolsPage.tsx`、`AgentsSection.tsx`；`app/src/kernel/sessions.ts` `refreshSessionModels` | pi 只在会话创建时读资源、AGENTS.md 和 `mcp.json`，要重新读得 `session.reload()`（会重跑全部扩展，生成中不安全）；照 Claude 桌面版改了本地 MCP 配置要重启才生效 | 你走查时觉得要在打开着的会话里立刻生效 |
| 停用整个包后单独打开一个资源的写法 | 这一类的过滤是 `[]` 时先写 `"!**"`，再照 `pi config` 加 `+路径` / `-路径`（例如 `["!**", "+skills\a\SKILL.md"]`） | `app/src/kernel/resourceToggles.ts` `togglePackageResource` | 照搬 `pi config` 会得到只有 `+路径` 的数组，pi 的 `applyPatterns` 没有普通包含时从全部文件开始，这一类的资源全都回来（扩展也一样）；`pi config` 自己不写 `[]`，是 Mori 的"停用整个包"写的。`"!**"` 先排除全部，之后的 `+`、`-` 照常生效，包里以后新加的资源仍是停用 | 你走查时；pi 升级时 |
| 不是本地文件夹的包（`npm:` `git:` `github:` `http:` `https:` `ssh:` 来源） | 工具页上卡只读，说明"内网只支持本地文件夹的包；这一项不会被安装，可以移除"，只能移除 | `app/src/kernel/resources.ts` `isRemote`、`packageReadOnly`；`ToolsPlugins.tsx` | Mori 只能添加本地文件夹，这种来源只会是手改 `<userData>\pi\settings.json` 写进来的，`PI_OFFLINE` 下 pi 不安装。它留在设置里时，pi 每次 `resolve()` 都同步跑一次 `npm root -g`（本机约 0.9 秒，后台进程这段时间停住，所有栏的输出都停）：工具页每次读取 1–2 次、每次启停 3–6 次（含写入后的确认），每个新会话 1 次（pi 自己的） | 内网要用 npm / git 包时 |
| 工具页对"没有要信任的内容"的文件夹重新判断 | 跟随的会话打开时是 none 的，工具页每次读取照新会话的判断再算一次（`decideTrust`，不带回答）：仍然没有 → 照旧；trust.json 有记录 → 按记录；否则按没有回答，不列出项目内容、显示"没有信任这个文件夹" | `app/src/kernel/resources.ts` `toolsTrust` | 上面"直接按信任处理"的理由是"那时没有项目资源可加载"；之后出现的项目配置没有人信任过，不能列出、不能改，也不能让 pi 读项目的 `npmCommand` | 你走查时 |
