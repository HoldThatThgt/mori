# 会话引用（M5）

依据：方案 5.11"会话引用"、5.3（右键菜单"Attach as context"、删除后引用显示"Session deleted"、草稿含引用芯片）、
第 6 节（历史由 `SessionManager.open(path).getBranch()` 交给界面；引用来源用 `appendCustomEntry("mori.ref", …)` 写进会话文件）。
引用芯片、发出的引用、回到原位置的通用做法沿用 M4（[selection.md](selection.md)），这里只写会话引用不同的地方。
拖会话到中栏分屏见 [split.md](split.md)。

## 开工前查的事实（pi 1.3.0 源码）

| 事实 | 影响 |
| --- | --- |
| `SessionManager.open(path)` 读出会话文件的全部条目，`getBranch()` 给出从根到当前叶子的条目；对 pi 1.3.0 写的完整文件不写任何东西（只在最后一行缺换行时补一个换行，旧版本格式才会改写） | 引用没打开的会话时，后台进程用它读出当前分支交给界面，不创建 pi 会话、不加载扩展、不问信任（新命令 `session.read`，方案第 6 节第 1 件与"历史"一条） |
| 打开中的会话由它自己的 `SessionManager` 写文件；它的 `getBranch()` 就是已经写进去的条目 | 引用后台进程里开着的会话时读它自己的分支，不另开一个读者 |
| pi 在本轮开始时就把你的消息写进会话（`message_end` 之后马上 `appendMessage`），助手回复、工具结果随后陆续写入，`agent_settled` 才算结束；生成中送达的插话、排队消息也写成你的消息，同一次运行里接着生成 | 后台进程在一次运行开始时（发出提示、或扩展发起的 `agent_start`）记下当时的叶子；会话在生成时 `session.read` 只交出已完成的轮次：这个叶子之后写进来的你的消息里，最后一条开始的那一轮还在生成，它之前的都已完成（按"一轮"的定义，下一条你的消息送达时上一轮就完了）；本轮你的消息还没写进来时到这个叶子为止 |
| `appendCustomEntry` 写的条目不进模型上下文；改名只追加一条 `session_info`，会话文件路径不变 | 引用来源（会话文件、轮次、条目 id）随 `mori.ref` 写进当前会话的文件；改名、重启后照样能跳回 |

## 一轮与引用的内容

- **一轮** = 你的一条消息，加上它之后、下一条你的消息之前的全部回复（方案 5.11）。轮次从会话当前分支的第一条你的消息起数，第 1 轮起。
  被压缩的较早对话仍在分支里，照常算轮次。
  （2026-10-26 注：见 file-system.md §5.3：轮次与右栏 This session 的 `Turn <n>` 用同一个计数（`turnNumbers`）：`mori.wake` 指向的 `[Mori]` 投递不是你的消息，
  不另起一轮，它的 `User:` 几行接到前一轮里，内容不丢（2026-10-27 注：负责人不在时按推荐定，待复核：实现时核对，`session.read` 本来就不交投递的消息与 `mori.wake` 条目（平行 Agent 规格 §13.11，`kernel/entries.ts` 的 `quotableEntries`），引用里没有它们的 `User:` 几行，编号也已跳过它们；照旧不交，模型看到的引用文字不变，见 docs/v1/fs-checks.md）；前面没有轮时同第一条你的消息之前的回复，不算在任何一轮里。所以芯片、预览与右栏、Rewind 通知里同一个编号指同一条消息。）
- **只取正文**：你的消息的文字、助手回复的文字；工具调用压成一行标题（与工具卡标题相同，例如 `[Tool] Read src/a.ts`）；
  思考内容、工具结果、系统消息、压缩摘要、扩展的消息都不取。
- 你的消息里带着引用（M4 的文件或回复引用、M5 的会话引用）时只取你写的字，每个引用压成一行 `[Quote] <来源>`
  （例如 `[Quote] src/a.ts, lines 1–3`；回复里的是 `[Quote] an earlier assistant reply`，
  会话引用是 `[Quote] session “<会话名>”, turns a–b`），不把被引用的全文再嵌一层。
- **内容由会话记录生成**（后台进程读出的条目），不从屏幕上取字：预览和发给模型的内容里没有"Copy""Thought process""Done"等界面文字。
- **默认范围**：全部已完成的轮次；全部超过 2 万字时默认改为最近 5 轮（临时默认值，见 defaults.md）。
- **字数**：引用内容的字符数（含每轮开头的 `Turn N`（2026-10-26 注：见 file-system.md §5.3：与右栏的 `Turn <n>` 同一个计数，投递接到前一轮里））；芯片上写"~X characters"
  （正好 1 时"~1 character"；1,000 以上取整到百，以下取整到十，100 以下照实）。

一段引用的内容（临时默认值，见 defaults.md）：

```text
Turn 3
User: 把登录按钮改成蓝色
Assistant: 我先看一下按钮在哪里定义。
[Tool] Read src/login.tsx
Assistant: 已经改好了。

Turn 4
……
```

发给模型的引用块，与 M4 的引用块拼法相同（引用块之后空一行接你的文字）：

```text
Quoting session “修复登录”, turns 3–4:
> Turn 3
> User: 把登录按钮改成蓝色
> ……
```

## 加入引用

两条路径做的事完全相同：

- 把侧栏的会话行（或分屏标题行上的会话名）拖到某一栏的输入框上，放下前输入框上浮一层"Drop to attach as context"；
- 焦点在某一栏时，在会话右键菜单选"Attach as context"（引用进焦点所在那一栏的输入框）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 菜单项不可用 | 中栏没有会话：旁边小字"No active session"；这一行就是焦点所在的会话："This is the current session"；这个会话还没有消息："No messages yet" | 菜单项灰掉 | — |
| 拖到自己的输入框上 | 拖的会话就是这一栏的会话 | 没有引用的提示（按"拖已在中栏的会话"处理，见 split.md） | — |
| 读取中 | 后台进程 `session.read`（会话文件） | 输入框上方一个芯片"Context · <会话名> · Loading…"；焦点到输入框 | ×（读屏名称"Cancel attaching “<会话名>”"）取消 |
| 已加入 | `session.read` 的结果：按上面的规则分轮，取默认范围（2026-10-26 注：见 file-system.md §5.3：轮次与右栏 This session 的 `Turn <n>` 同一个计数，`mori.wake` 指向的投递不另起一轮） | 芯片"Context · <会话名> · turns 3–8 · ~3,200 characters"（只有一轮时"turn 3"），读屏名称"<芯片上的字>, open preview"；会话名悬停看全名 | 点芯片打开预览；×（读屏名称"Remove context: <芯片上的字>"）移除 |
| 只取了已完成的轮次 | 来源还在生成，`session.read` 说明有一轮没完成 | 芯片同上（只含已完成的轮次）；预览里说明"This session is still running. Only the N finished turns are listed."（只有 1 轮时"Only 1 finished turn is listed."） | 同上 |
| 没有可引用的内容 | 来源没有已完成的轮次（例如第一轮还在生成） | 输入框上方一行提示"“<会话名>” has no finished turns yet, so there’s nothing to attach." | ×（读屏名称"Dismiss warning"）关掉提示 |
| 读取失败 | `session.read` 报错（会话文件不在了、后台进程已退出等） | 输入框上方一行"Couldn’t attach “<会话名>” as context: "加原文 | × 关掉提示 |
| 重复 | 输入框里已经有引用同一个会话的芯片 | 不再加一个，焦点到输入框 | — |
| 草稿 | 芯片随草稿按会话文件存在本机（与 M4 的引用芯片同一个键 `mori.draftRefs`），保存的是引用时的内容和范围 | 切换会话、去设置页再回来、重启后都在 | — |
| 发送 | 与 M4 相同：`session.prompt` 带上 refs，发给模型的全文是引用块加你的文字；只有芯片、没写字也能发 | 芯片清空；你的消息上方显示引用（见下） | — |

## 预览与调整范围

照 Claude 桌面版：点输入框里的附加内容卡片，打开一个对话框看全文。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 读取中 | 你点了输入框里的会话引用芯片（或在它上面按 Enter）：后台进程再读一次来源（`session.read`） | 对话框"Context · <会话名>"，"Loading…" | Esc 或"Cancel"关闭 |
| 预览 | `session.read` 的结果 | 顶部"From [Turn a] to [Turn b]"和总字数"~X characters"（两个下拉框，读屏名称"From turn"、"To turn"，选项"Turn N"，列出全部已完成的轮次）；下面按轮列出：每轮一节，标题"Turn N · ~Y characters"（2026-10-26 注：见 file-system.md §5.3：N 与右栏的 `Turn <n>` 同一个计数，`[Mori]` 投递的 `User:` 几行在前一轮的内容里），内容是这一轮引用的原文（不渲染 Markdown，就是发给模型的文字）；范围外的轮次变淡，标题后加" · Not attached"；对话框打开时滚到范围的第一轮 | 改下拉框（开始晚于结束时另一端跟着改）；"Done"按新范围更新芯片；"Cancel"或 Esc 不变 |
| 来源还在生成 | 同上，后台进程说明有一轮没完成 | 顶部多一行"This session is still running. Only the N finished turns are listed."（只有 1 轮时"Only 1 finished turn is listed."） | 同上 |
| 来源变了 | 芯片的第一轮、最后一轮在来源里找不到（例如被外部改写了） | 一行"The session changed since you attached it, so the range was reset to the default."，范围回到默认；已完成的轮次一轮都没有了时"The session no longer has finished turns · Showing the attached text"，显示芯片里保存的内容 | 同上 |
| 原会话已删除 | `session.read` 报会话文件不在，或会话列表里已经没有它 | "Session deleted · Showing the attached text"，显示芯片里保存的内容；不能改范围 | "Close"或 Esc |
| 读取失败 | `session.read` 报其他错误 | "Couldn’t read the session: <原文> · Showing the attached text"，下面是芯片里保存的内容 | Close |

标题"Context · <会话名>"始终完整显示在一行：会话名太长时截断加省略号，不折行。

焦点：打开时在"From turn"的下拉框；Tab 只在对话框里循环；关闭后焦点回到芯片。

## 发出的消息里的引用

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 刚发出、重新打开、重启后 | 与 M4 相同：`mori.ref` 条目（`{ messageId, refs }`），重新打开时从会话记录读出 | 你的消息上方：会话图标、"Context · <会话名> · turns 3–5 · ~X characters"（读屏名称"<这串字>, jump to session"）、内容的前 3 行（渐隐）；会话名取原会话现在的名字（改名后显示新名字），找不到时用引用时的名字 | 点它回到原会话 |
| 回到原会话 | 你点了引用（或在它上面按 Enter） | 与在侧栏点这个会话相同：已在某一栏就把焦点切过去，开在后台就换到焦点所在的那一栏，没打开就打开（需要时先问信任）；然后滚到第 a 轮你的消息，第 a–b 轮高亮约 4 秒；不在已载入的 50 条里时先载入到它；这几轮里有折起的步骤组时先展开它们，再滚动、高亮（2026-10-26 走查 M18，[chat.md](chat.md)"步骤组"） | — |
| 改名之后 | 改名不改会话文件 | 照样跳回；显示新名字 | 同上 |
| 原会话已删除 | 会话列表（pi 的 `listAll`）读完了、里面没有这个会话文件，本次也没有打开它 | 引用上标"Session deleted"；点它打开预览对话框，显示引用时的原文（只读） | Close |
| 原文已变化 | 原会话打开后在当前分支上找不到第 a 轮你的消息的条目 | 引用上标"Source changed"；同时打开预览对话框显示引用时的原文 | Close |

输入框里的芯片在原会话被删除后同样标"Session deleted"，仍然可以发送（内容是引用时存下的）。

## 引用的来源记成什么

`mori.ref` 条目里每个会话引用记：

| 字段 | 含义 |
| --- | --- |
| `quote` | 引用的内容（上面的格式），原会话删除后仍可查看 |
| `source.kind` | `"session"` |
| `source.sessionFile` | 原会话的会话文件（改名不变） |
| `source.name` | 引用时显示的会话名 |
| `source.fromTurn` / `source.toTurn` | 引用的第几轮到第几轮 |
| `source.fromEntryId` / `source.toEntryId` | 这两轮你的消息的条目 id（回到原位置、预览里重新找范围用） |

## 后台进程多做的事

| 命令 | 做什么 | 对应 |
| --- | --- | --- |
| `session.read`（会话文件） | 后台进程里开着的会话：它的 `getBranch()`，在生成时只交出已完成的轮次；没开着的：`SessionManager.open(文件).getBranch()`（不创建会话、不加载扩展）；文件不在时报 `Session file not found`。只交出你的消息、助手回复和 `mori.ref` 条目（工具结果里的文件内容、命令输出、图片引用里不取，不搬给界面）（协作模式：见 docs/specs/parallel-agents-taskboard.md §5.6、§13.11：去掉 `mori.wake` 指向的程序投递消息）。返回条目、会话名、工作目录、是否有一轮还没完成 | 方案第 6 节第 1 件（调用 pi SDK 打开会话）与"历史"（`SessionManager.open(path).getBranch()` 交给界面） |

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 输入框的放下提示 | `[data-testid="drop-hint"][data-kind="reference"]` |
| 输入框里的会话引用芯片 | `[data-testid="quote-chip"][data-kind="session"]`；读取中的 `data-pending="true"` |
| 引用的提示（没有可引用的内容、读取失败） | `[data-testid="ref-problem"]` |
| 预览对话框 | `[data-testid="ref-preview"]`；每一轮 `[data-testid="ref-turn"][data-turn][data-included]`；字数 `[data-testid="ref-total"]` |
| 发出的会话引用 | `[data-testid="sent-quote"][data-kind="session"]`；状态 `[data-testid="quote-status"]` |

## 反例

- 预览和发给模型的内容里没有界面文字（按钮、"Thought process"、工具卡状态），也没有思考内容和工具输出。
- 引用正在生成的会话时，正在生成的那一轮不在内容里，也不在下拉框里。
- 拖到输入框上不会分屏；拖到中栏不会引用。
