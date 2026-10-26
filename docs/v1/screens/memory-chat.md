# 对话里的记忆：memory 工具卡、新会话提示、反馈表单

依据：提示词分层与记忆构建规格（[memory.md](../../specs/memory.md)，下称“规格”）§7.2（谁有这个工具）、§7.4（结果与错误）、§7.5（批准与工具卡）、§7.6、§7.7（记忆目录的写保护）、
§9.9（新会话的提示）、§10.6（横幅）、§10.7（反馈表单）、§10.10（后台进程退出时）、§8（动作记录）。
补充 [v0 tool-cards.md](../../v0/screens/tool-cards.md) 的标题对照表与状态表、[v0 tools.md](../../v0/screens/tools.md) 的内置工具列表；
取代 [v0 selection.md](../../v0/screens/selection.md)“反馈”的底部说明与 `Saved · View in Review`。点了之后打开的记忆页见 [memory-page.md](memory-page.md)。
界面文字为英文，按规格原文。规格标了“临时”的文字（登记在规格 §12）写作“（临时，规格 §12）”；规格没给、本表定的写作“（临时，走查时可以改）”。

## 来源

| 来源 | 内容 |
| --- | --- |
| pi 的工具事件（`toolcall_start`、`toolcall_delta`、`tool_execution_start`、`tool_execution_end`）与 `mori.tool_gate` | 同 v0 工具卡；`memory` 的 `mori.tool_gate` 为 `free`（§7.5） |
| `memory` 工具调用的参数 | `action`（`save` / `update` / `forget`）、`kind`、`layer`、`entry`、`abstract`、`detail`、`note`、`quote`、`asked`（§7.1）：工具卡标题；`asked` 不进标题，只决定记下的条目算你说的还是 Mori 记的（§6.4，2026-10-26） |
| `memory` 工具结果 | 一行英文（§7.4）；成功时 `details: { revision, kind, layer, entry }`（`shared/memory.ts` 的 `MemoryToolDetails` 另带 `action`）；失败时 `isError: true` |
| 会话文件里的工具结果 | 重新打开的会话：`history.ts`、`transcript.ts` 从会话文件的 `details` 读出同样的字段 |
| `SessionInfo.memoryNotice` | `{ revisions, counts, from, to }`：只有 `session.create`（新建）的结果带，打开已有会话为 null（§9.9） |
| `enhance.get { cwd }` 的结果 | 反馈表单的说明：`enabled`、`error`（§10.7） |
| 主进程保存反馈 | `mori:save-feedback` 的结果（同 M4） |
| 界面的后台进程状态 | 后台进程退出时 `View in Memory`、`View` 不可用 |
| 你的操作 | 点 `View in Memory`、`View`、`Dismiss`；打开反馈表单、`Save` |

## memory 工具卡

### 标题（§7.5）

工具卡、阶段行与会话引用里的 `[Tool]` 行用同一段标题（`toolTitle.ts`）。

| 调用 | 标题（动词 · 目标） |
| --- | --- |
| `save` | `Save to <Facts\|TASTE\|STRATEGY\|REVIEW>` · `<abstract>` |
| `update` | `Update memory` · `<entry>`（你给的 id 或原文） |
| `forget` | `Delete from memory` · `<entry>` |
| 参数还没写完 | 按动作给动词：`save` 还没有合法的 `kind` 时 `Save to memory`（`shared/memory.ts` 的 `memoryToolTitle`，临时，走查时可以改）；`update`、`forget` 同上表；目标（`abstract` 或 `entry`）还没收到时写作 `…`（同 v0 tool-cards 的 `Run …`、`Read …`，临时，走查时可以改） |

proposal §6.2 的“记忆 · 改了 1 条”就是这张卡：标题写动作和条目，结果行写 §7.4 的原文。

### 状态

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 准备中 / 等待执行 | 同 v0 | 同 v0：标题 + `Preparing…` / `Queued` | 展开 |
| 执行中 | `mori.tool_gate` 为 `free` 时的 `tool_execution_start` | `Running…`；不出批准卡，权限模式为 `Ask each time` 时也不出（`memory` 在 `FREE_TOOLS`，§7.5）；没有 `Allowed for this session` / `Allow all` 小字（同 v0 免批准的工具） | 展开 |
| 完成 | `tool_execution_end`，`isError` 为假，结果带 `details` | 状态 `Done`（实时运行时带耗时，同 v0），后面一个按钮 `View in Memory`（`tool-memory-view`，写法同 `TitleTarget`，点了不展开卡片）；展开后 Output 是 §7.4 的一行：`Saved to STRATEGY (this project): <abstract>`、`Saved to Facts (user level): <abstract>`、`Updated STRATEGY (this project): <abstract>`、`Deleted from STRATEGY (this project): <abstract>` | View in Memory；展开 |
| 完成（主动记的，2026-10-26） | 同上，调用没给 `asked` 或为 `false`（你没说“记一下”，规格 §0 第 5 条） | 同上一行：卡片与结果原文不分你要它记的还是它主动记的；`View in Memory` 打开的那一条标 `Added by Mori`（[memory-page.md](memory-page.md)） | View in Memory；展开 |
| 失败 | `tool_execution_end`，`isError` 为真 | `Failed · <原因第一行>`（§7.4 的原因，例如 `Failed · Over the 500-token limit for STRATEGY: user 200 + this project 320 = 520. Merge or delete entries first.`、`Failed · No entry matches “…”. Entries you can change: …`）；写法或规则的错误展开后 Output 第二行是 `Correct form: …`（附录 A.4）；没有 `View in Memory` | 展开 |
| 参数不合 schema | pi 的校验错误（规格写作 `Validation failed for tool memory …`；pi 1.3.0 的原文第一行是 `Validation failed for tool "memory":`，不进执行） | `Failed · Validation failed for tool "memory":`；展开后 Output 是 pi 的全文（各项错误与收到的参数）；没有 `View in Memory` | 展开 |
| 分开时对话调用 | 协作模式分开时对话会话没有启用 `memory`，pi 按不在启用的工具里拒绝（在 `tool_call` 处理器之前，同 TB-09 的 `bash`，§7.6） | `Failed · Tool memory not found`；什么都没写；没有按钮 | 展开 |
| 已停止 / 已中断 | 同 v0 | `Stopped` / `Interrupted`；没有按钮 | 展开 |
| 重新打开会话 | 会话文件里这次调用的工具结果与 `details` | 完成的卡仍有 `View in Memory`（不显示耗时，同 v0） | View in Memory |
| 后台进程退出 | 界面的后台进程状态 | `View in Memory` 不可用，悬停 `Mori’s background process crashed. Restart it to continue.`（§10.10） | 展开 |

### View in Memory

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| `save`、`update` 的卡 | `details.layer`、`details.kind`、`details.entry` | 打开记忆页：层为 `details.layer`（`project` 时是这张卡所在会话的项目，记忆页跟随卡片所在的那一栏，临时，走查时可以改），分节为 `details.kind`，选中 `details.entry`，右栏打开它的详情；F8 记 `View in Memory` | — |
| `forget` 的卡 | 调用的 `action` 为 `forget`；`details.revision` | 打开记忆页那一层的 `Revisions`，选中 `details.revision`，右栏打开那次修订 | — |
| 条目后来不在了 | 打开时 `memory.get` 返回 `entry: null`（之后被删、被移走或被回滚） | 列表照常，详情不打开（按 memory-page.md“数据何时读”的规则） | — |
| 修订后来不在了 | `memory.revisions { id }` 返回 `revision: null` | `Revisions` 列表照常，详情不打开（同上） | — |

### 谁的卡会出现

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 关闭模式的主 Agent | 用户会话，模式 `off`（基座，或写了 `tools` 的对话角色，§7.6） | 调用照上表显示 | — |
| 合并会话在协作模式下 | 兼立项（§7.2） | 同上 | — |
| 分开时的立项实例 | 实例会话（§7.2） | 不出工具卡（实例的调用只在进展摘要里，[team-stream.md](team-stream.md)） | — |
| 结案、task、临时提问、订阅 | 它们没有这个工具（§7.2） | — | — |
| 增强会话 | 看不见的会话（§9.6） | 界面收不到它的事件，没有卡；它的改动在记忆页的 `Revisions` 里 | — |

### 工具页

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 内置工具列表 | `tools.get` 的 `tools`（跟随的会话里注册了 `memory` 时，§7.6） | 一行 `memory`，来源 `Mori`（同 TaskBoard 工具，`resources.ts` 对 `<inline:mori-memory>` 的处理）；状态按这个会话启用了没有（`Enabled` / `Not enabled`，例如协作模式分开时的对话会话是 `Not enabled`）；没有开关，下面一行 `Mori turns this on for the main agent.`（2026-10-26，负责人走查 M12，[../../v0/screens/tools.md](../../v0/screens/tools.md)"内置工具"） | 展开看说明 |

### 记忆目录的写保护（§7.7）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| `write`、`edit` 写进记忆目录 | `mori-memory` 的 `tool_call` 拒绝（在批准之前），工具结果 `isError` | 那张 `Write <path>` / `Edit <path>` 卡：`Failed · Memory files can only be changed with the memory tool or on the Memory page.`；不出批准卡；文件不变 | 展开 |
| 写到 `<userData>` 下前缀相同的兄弟目录或别处 | 不在记忆目录里 | 照 v0（要批准的照常出卡） | 同 v0 |

## 新会话的提示

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 有提示 | `SessionInfo.memoryNotice` 不为 null：这个项目新建的第一个会话，在增强改了东西之后（§9.9） | 对话流上面一行横幅（`memory-notice`，`SessionBanners` 的写法，排在信任与扩展的横幅之后，位置临时，走查时可以改）：`Enhancement updated this project’s memory from the <Mon D> sessions: <KIND> <n>, <KIND> <n>.`（临时，规格 §12；`shared/memory.ts` 的 `memoryNoticeText`）；`from` 与 `to` 不同时写 `from the <Mon D>–<Mon D> sessions`；只列不为 0 的种类，按 TASTE、STRATEGY、REVIEW；后面按钮 `View`（`memory-notice-view`）与 `Dismiss` | View；Dismiss |
| View | 你点了 `View` | 打开记忆页 → `Project` → `Revisions`，选中 `revisions` 里最后一个（时间最近的那次），右栏打开它；F8 记 `View in Memory`；横幅不因此消失（临时，走查时可以改） | — |
| Dismiss | 你点了 `Dismiss` | 横幅消失；F8 记 `Dismiss memory notice` | — |
| 切到别的会话再回来 | 你在这一栏换了会话又换回来 | 不再显示（`notice` 在建会话时已经清空，横幅只在这次打开里显示） | — |
| 多次运行之后 | `memoryNotice` 合并了几次修订（§9.1 的 `notice`） | 各种类的数是这些修订之和，日子写范围；`View` 选中时间最近的那次 | View |
| 失败的运行写入过改动 | §9.8、§9.10：失败的运行有改动时同样进 `notice` | 同样有横幅；`View` 打开那次失败的修订 | View |
| 没有提示 | `memoryNotice` 为 null：打开已有的会话、这个项目的第二个新会话、增强没改东西 | 没有横幅 | — |
| 后台进程退出 | 界面的后台进程状态 | `View` 不可用，悬停 `Mori’s background process crashed. Restart it to continue.`；`Dismiss` 照常（临时，走查时可以改） | Dismiss |

## 反馈表单

在 [v0 selection.md](../../v0/screens/selection.md)“反馈”的基础上，只改底部说明与保存后的文字（§10.7）；表单的其余部分（引用原文、输入框、`Cancel`、`Save`、`Saving…`、保存失败）不变。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 打开 | 你点了浮层的 `Feedback` 或回复下的 `Give feedback`；表单发 `enhance.get { cwd }`（`cwd` 是这条反馈所在会话的工作目录） | 底部说明这一行（`feedback-note`）先留空、占好这一行的高度，不先显示另一种说法 | 输入；Save；Cancel |
| 开着增强 | `enhance.get` 返回 `enabled` 为真、`error` 为 null | 说明整段是 `Saved as evidence for this project’s daily enhancement. To have Mori act on it now, use “Attach as context” instead.` | 同上 |
| 没开增强 | `enabled` 为假；或 `error` 不为 null（读不出增强设置、项目目录被别的工作目录占用，§3）；或 `enhance.get` 失败 | 说明整段是 `This project doesn’t have enhancement on, so feedback is only saved. To have Mori act on it, use “Attach as context” instead.` | 同上 |
| 会话没有项目 | 会话的 `cwd` 为空 | 同“没开增强”；不发 `enhance.get`（它要求 `cwd`） | 同上 |
| 后台进程退出 | 界面的后台进程状态 | 同“没开增强”（反馈照样能存，同 M4） | 同上 |
| 已记录 | 主进程写好 `<userData>/feedback/<时间>.json` | 表单换成 `Saved`（`feedback-saved`；原来的 `Saved · View in Review` 去掉链接），约 3 秒后关闭（同 M4） | Esc 立即关闭 |
| 反馈去哪了 | §10.7、§9.5 | 不再单独成列表：开着增强时，会话工作目录与项目相同、`createdAt` 落在那一天的反馈交给那天的三个增强任务（§9.5）；被用作依据时出现在条目详情的 `Evidence`（`<Mon D> · Feedback: “<quote>”`，日期是 `createdAt` 的本地日期）和用到它的修订里 | 在记忆页 `Jump to source`（memory-page.md） |

## 反例

- `memory` 的调用从不出批准卡；`Write`、`Edit` 写进记忆目录被拒绝时也不出批准卡。
- 失败的 memory 卡、停止或中断的卡没有 `View in Memory`。
- 打开已有的会话、第二个新会话没有提示横幅；增强没改东西时没有横幅。
- `Dismiss` 之后、换到别的会话再回来，横幅不再出现。
- 反馈表单的说明不会先显示“没开”的那一段再换成“开着”的那一段。
- 反馈保存后没有 `View in Review`，也没有指向记忆页的链接。
- 关着增强的那些天存下的反馈，之后打开增强也不会被读到（从打开那天读起，关着期间的日子不补，§9.1、§12）；打开当天早些时候存下的照样交给当天的运行。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：参数没写完、还没有合法 `kind` 时标题 `Save to memory`（按 `shared/memory.ts` 的 `memoryToolTitle`）；
参数没写完、目标还没收到时目标写作 `…`（同 v0 tool-cards）；
`View in Memory` 打开时记忆页跟随卡片所在的那一栏；横幅排在信任与扩展横幅之后；点 `View` 后横幅不消失；后台进程退出时 `Dismiss` 照常可用。

规格自己标“临时”、登记在规格 §12 的：新会话提示的横幅文字。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 工具卡 | 沿用 v0 的工具卡标识；完成的 memory 卡里 `data-testid="tool-memory-view"` |
| 新会话提示 | `memory-notice`；`View` 为 `memory-notice-view`；`Dismiss` 为 `data-action="dismiss"`（本表定，临时） |
| 反馈表单 | 说明 `feedback-note`；保存后 `feedback-saved`；`feedback-open-review` 去掉 |
