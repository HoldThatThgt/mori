# 记忆页

依据：提示词分层与记忆构建规格（[memory.md](../../specs/memory.md)，下称“规格”）§10.1（记忆页）、§10.2（依据回到原位置）、§10.3（AGENT）、§10.5（Revisions 节）、
§10.10（后台进程退出时）、§3（读不出来的条目、编码冲突）、§6（预算、谁能改什么、修订、回滚、反向链接）、§8（命令、事件与动作记录）。
取代 [v0 review.md](../../v0/screens/review.md)（工作回顾，M7）的入口、页面、反馈部分与回到原位置；它的 UI issues 部分见 [settings-issues.md](settings-issues.md)。
`Project` 顶部的增强一块见 [memory-enhance.md](memory-enhance.md)；从对话进来的 `View in Memory`、新会话提示的 `View` 见 [memory-chat.md](memory-chat.md)。
界面文字为英文，按规格 §10 原文。规格标了“临时”的文字（登记在规格 §12）写作“（临时，规格 §12）”；规格没给、本表定的写作“（临时，走查时可以改）”。

## 来源

| 来源 | 内容 |
| --- | --- |
| `memory.list { cwd, layer, kind }` 的结果 | `entries: EntryRow[]`（`id`、`abstract`、`source`、`created`、`modified`，按索引顺序，也就是进 prompt 的顺序）、`usage { used, limit, user, project }`（`User` 层时 `project` 为 0）、`broken: { name, error }[]`、`last: RevisionRow \| null`（这一层改到这一种的最近一次修订）、`error` |
| `memory.get { cwd, layer, id }` 的结果 | `entry: EntryDetail \| null`（frontmatter 的字段、`details`、`evidence`、`history`、`file`）、`revisions: RevisionRow[]`（改过它的，时间倒序）、`backlinks: EntryRef[]`（按种类、abstract 排列）、`error` |
| `memory.revisions { cwd, layer }` / `{ cwd, layer, id }` 的结果 | `{ revisions: RevisionRow[], error }`（这一层 `revisions/` 的 frontmatter，时间倒序，最多 200 条）/ `{ revision: RevisionDetail \| null, error }`（`changes`、`notes`、`run`） |
| `memory.save` / `memory.delete` / `memory.move` / `memory.rollback` 的结果 | `{ error, revision }`，`memory.save`、`memory.move` 另有 `id`；`error` 只有原因，界面加前缀（§8） |
| `mori.memory_changed { cwd, layers, kinds, revision }` | 全局事件：每次写入之后；增强运行在 `beginRun`、`endRun` 各一次（§8） |
| `agents.get { sessionId }` 的结果 | v0 的 `effectivePath` 等，加 `loaded: { path, tokens }[] \| null`、`userTokens`、`total`（§10.3） |
| 界面的会话状态 | 跟随的会话（同 Customize 的 `followedOf`：焦点那一栏的会话，打开中时等它，打开失败时算没有）；侧栏的会话列表与会话名（依据行、`Jump to source`） |
| `session.read`（会话依据带 `anchor`）、`session.open`；主进程的 `mori:read-file`（阅读器的只读通道） | 依据跳转（同 M7 的 `jumpBack`，§10.2）：会话依据发 `session.read { sessionFile, anchor: <entry> }`，结果的 `anchor` 是后台进程在完整的当前分支上找到的那条你的消息或助手回复（§8）；反馈依据的反馈记录 `<userData>\feedback\<文件名>` 经 `mori:read-file` 读（按 agentDir `<userData>\pi` 的 `..\feedback\<文件名>`），不另加通道 |
| 界面的后台进程状态 | 后台进程退出、重新连上（§10.10） |
| 你的操作 | 换层、换分节、选行、`New entry`、`Edit`、`Save`、`Delete…`、移动、`Jump to source`、回滚 |

`<KIND>` 是种类的名字 `Facts`、`TASTE`、`STRATEGY`、`REVIEW`（`shared/memory.ts` 的 `KIND_LABEL`）；`<Mon D>` 是 `Oct 22` 这样的日期，`<hh:mm>` 是本地时间（24 小时制）。

## 入口与外框

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 左栏 `Memory` | — | `Customize` 下面、原来 `Review` 的位置一项 `Memory`（`nav-memory`，图标 `memory`：一本书）；左栏收起为图标栏时是图标按钮，悬停 `Memory`；在记忆页时高亮（同 M7）。左栏没有 `Review` | 打开记忆页；F8 记 `Open Memory` |
| 后台进程退出 | 界面的后台进程状态 | `Memory` 不可用，悬停 `Mori’s background process crashed. Restart it to continue.`（同 Customize） | — |
| 页面 | 你打开了记忆页 | `section.memory-page[data-testid="memory-page"]`；顶栏 `Back to app` 与标题 `Memory`；下面是层、（`Project` 时）增强一块、分节、中栏内容；选中时右栏是详情 | `Back to app`（恢复分屏、滚动位置、右栏的文件、草稿，同设置页与 M7） |
| 从对话进入 | 工具卡的 `View in Memory`、新会话提示的 `View`（memory-chat.md） | 直接打开到那一层、那一节，选中那一条或那一次修订 | — |
| F8 的 Current view | 界面状态 | `Page: Memory`（§10.9） | — |

## 层：User ｜ Project

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 有跟随的项目 | 跟随的会话打开好了 | 分段按钮 `User` ｜ `Project`（`memory-scope-user` / `memory-scope-project`，当前的按下）；`Project` 旁写项目文件夹名 | 换层：清空并按新的层读（下面“数据何时读”）；F8 记 `Memory: User` / `Memory: Project` |
| 跟随的会话还在打开 | 跟随的会话在“正在启动…” | `Project` 的内容等它打开好再读，期间是 `Loading…`（同 Customize、M7）；`Project` 已有列表时（例如 `Restart` 之后）`New entry` 等它打开好；`User` 层不等，照常读、`New entry` 可用 | 换到 `User` |
| 没有跟随的项目 | 没有打开的会话，或焦点会话打开失败 | `Project` 不可用，悬停 `Open a session to see this project’s memory.`；只看 `User` | — |
| 跟随的项目改变 | 焦点换到另一个项目的会话（例如在侧栏归档或删除了跟随的会话，跟到剩下的那一栏；分屏换焦点） | 页面跟着换：清空并读那个项目，不显示上一个项目的结果；回到你上次在那个项目看的分节（§10.1；按项目记在这次运行的内存里，没看过的项目保持当前分节，临时，走查时可以改）；有未保存的编辑时先问（下面“离开确认”） | — |
| 跟随的项目没了 | 正在看 `Project` 时跟随的会话不在了、也没有剩下的一栏 | 换到 `User`（临时，走查时可以改） | — |
| 打开记忆页时的层与分节 | — | 第一次打开：有跟随的项目时 `Project`，没有时 `User`；分节 `Facts`。这次运行里再打开时回到上次的层与分节（同 M7 记住分节，直到重启）（都是临时，走查时可以改） | — |

- `User` 层看用户级的条目（每个项目的 prompt 里都有它们）；`Project` 层看本项目的条目，用量另加上用户级这一种（§6.3）。
- 本项目按工作目录精确匹配（大小写不同算不同项目，子文件夹不算同一个项目，§3）。

## 分节

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 分节按钮 | — | `Facts`、`TASTE`、`STRATEGY`、`REVIEW`、`AGENT`、`Revisions`（`memory-section-<facts\|taste\|strategy\|review\|agent\|revisions>`，当前的 `aria-pressed="true"`） | 换分节：清空并读；F8 记 `Memory: <Facts\|TASTE\|STRATEGY\|REVIEW\|AGENT\|Revisions>` |
| 前四节 | — | 用量一行、列表（下一节）；选中一行时右栏是条目详情 | 见下 |
| `AGENT` | — | 加载的 AGENTS.md 与 token 数（下面“AGENT”） | 见下 |
| `Revisions` | — | 修订列表；选中一行时右栏是修订详情（下面“Revisions”） | 见下 |

## 前四节：用量与列表

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 用量（`Project`） | `memory.list` 的 `usage` | 第一行 `<used> / 500 tokens · User <u> + this project <p>`（`memory-usage`；`used` = 用户级 + 本项目） | — |
| 用量（`User`） | 同上 | `<used> / 500 tokens`（只算用户级） | — |
| 超出 | `usage.used` > 500（手改过文件时会出现；恰好 500 不算） | 数字为警告色，后面加 ` · Over the limit`；条目照样全部进 prompt（不截断，§6.3） | 删或改短条目 |
| 最近一次修订 | `memory.list` 的 `last` 不为 null | 同一行 `Last change <Mon D> · Added 1, changed 1`（`memory-last-change`；日期取 `last.time`；计数为 0 的不写，都为 0 时 `No changes`） | 点它：切到 `Revisions` 选中那一次（有未保存的编辑时先问） |
| 没有修订 | `last` 为 null | 不写 `Last change` | — |
| `New entry` | — | 同一行按钮 `New entry`（`memory-new`） | 打开新增表单（下面“编辑与新增”；有未保存的编辑时先问） |
| 列表 | `memory.list` 的 `entries` | `memory-list` 里每条一行（`memory-row`，`data-id` 为 id，`data-source` 为 `user` / `agent` / `learned`）：abstract；右边 `You said`、`Added by Mori`（Mori 主动记的，照 Claude 的 `Added by Claude`；2026-10-26，规格 §0 第 5 条）或 `Learned` 与修改日期 `<Mon D>`（取 `modified` 的日期）；顺序就是进 prompt 的顺序 | ↑ ↓ 在行之间移动焦点（同 M7）；Enter 或点击选中，右栏打开详情（有未保存的编辑时先问） |
| 选中 | 你选了一行 | 这一行高亮；右栏是它的详情 | — |
| 读不出来的条目 | `memory.list` 的 `broken` | 每个一行（`memory-broken`）：第一行 `Couldn’t read the entry <文件名>`，下一行是原因；不能选中（规格 §10.1）；排在条目之后（临时，走查时可以改）；不进 prompt | — |
| 没有条目 | `entries` 与 `broken` 都为空 | `No entries yet.` | `New entry` |
| 读取中 | 第一次读，`memory.list` 还没返回 | 列表的位置 `Loading…`（同 M7） | — |
| 重读 | 收到这一层的 `mori.memory_changed`（下面“数据何时读”） | 上一次的列表、选中与滚动位置留着，标题旁 `Loading…`（同 M7） | 照常 |
| 读取失败 | `memory.list` 的 `error` 不为 null | 列表的位置 `Couldn’t load memory: <原因>`；规格没给重试按钮：换层、换分节或重新打开记忆页时再读 | 换层、换分节 |
| 项目目录被占用 | `error` 为 `This project’s memory folder belongs to <cwd>.`（编码冲突，§3） | `Couldn’t load memory: This project’s memory folder belongs to <cwd>.` | 看 `User` |

## 条目详情（右栏）

右栏的宽度与分隔线同 M7 的右栏（与会话的右栏共用宽度，窗口窄于 800px 时浮在中栏上层）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 读取中 | `memory.get` 还没返回 | `aside.right-panel[data-testid="memory-detail"]` 里 `Loading…`（临时，走查时可以改） | — |
| 标题 | `memory.get` 的 `entry` | 标题是 abstract；右上角 ×，读屏名称 `Close details`（同 M7，临时，走查时可以改）；下面一行 `<KIND> · <User\|Project> · <You said\|Added by Mori\|Learned> · Created <Mon D> by <you\|Mori\|enhancement> · Modified <Mon D> by <you\|Mori\|enhancement>`（`created`、`modified` 里的 `You`、`Mori`、`Enhancement` 分别写 `you`、`Mori`、`enhancement`） | 关闭（×，有未保存的编辑时先问） |
| `Evidence` | `entry.evidence` | 小标题 `Evidence`，块 `memory-evidence`；每项一行：`<Mon D> · Session “<title>”: “<quote>”` 或 `<Mon D> · Feedback: “<quote>”`（没有 `quote` 时去掉 `: “…”`；`<title>` 先按 `session` 在侧栏找到会话、用现在的名字，找不到时用存下的 `title`），后面 `Jump to source`（`memory-jump`，下面“依据回到原位置”） | Jump to source |
| 没有依据 | `evidence` 为空（例如你在记忆页写的） | `No evidence recorded.` | — |
| `Details` | `entry.details` | 小标题 `Details`；按 Markdown 渲染（与对话流是同一个组件 `components/Markdown.tsx`，2026-10-26 起 mermaid 代码块画成图，见 ../../v0/screens/chat.md"图"）；`[[slug]]` 渲染成链接（同层先找，找不到再找另一层）；找不到时显示原文、不可点 | 点链接：在详情里打开那一条；中栏换到它所在的层与分节并选中它（临时，走查时可以改）；有未保存的编辑时先问 |
| `Linked from` | `memory.get` 的 `backlinks` | 小标题 `Linked from`，块 `memory-backlinks`；每条一行 `<KIND> · <abstract>`（临时，走查时可以改）；没有反向链接时不显示这一块 | 点一行：同 `[[slug]]`（临时，走查时可以改） |
| `History` | `entry.history`（`## Revisions` 的行）与 `memory.get` 的 `revisions` | 小标题 `History`，块 `memory-history`：先是 `## Revisions` 的每一行原文（例如 `Oct 25 · Enhancement: …`），再是改过它的每次修订一行：标题与时间 `<Mon D> <hh:mm>`（时间写法临时，走查时可以改）；两者都没有时不显示这一块（临时，走查时可以改） | 点修订那一行：切到 `Revisions` 选中那一次（有未保存的编辑时先问） |
| 操作 | — | `Edit`（`memory-edit`）、`Delete…`（`memory-delete`）；`Project` 时 `Move to user level`，`User` 且有跟随的项目时 `Move to this project`（`memory-move`）；`User` 而没有跟随的项目时没有移动按钮 | 见下面三节 |
| 读取失败 | `memory.get` 的 `error` | 详情的位置 `Couldn’t load memory: <原因>` | 关闭；再选一次 |
| 条目不在了 | 重读的 `memory.get` 返回 `entry: null`（被删、被移走、被回滚掉），或点的链接指向的条目已不在 | 关闭详情，焦点回到列表 | — |
| 写入失败 | 保存、删除、移动的 `error` | 详情顶部 `memory-error`：`Couldn’t save: <原因>` / `Couldn’t delete: <原因>` / `Couldn’t move: <原因>`；你的改动不丢；下一次操作时消失（临时，走查时可以改） | 改后再试 |

写入失败的原因（内核原文，§3、§6.3、§6.6、§6.7、§8）：预算 `Over the 500-token limit for STRATEGY: user 200 + this project 320 = 520. Merge or delete entries first.`
（写用户级时超出某个项目：`… user 260 + project D:\shop 300 = 560 …`）、`This entry no longer exists.`、`This project’s memory folder belongs to <cwd>.`、
`The revision wasn’t written: <原文>`（条目的改动已保留）、表单的三句（内核按同样的规则再查一次）、写文件的系统错误原文。

## 编辑与新增

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 编辑 | 你点了 `Edit` | 详情换成表单（`memory-form`，`noValidate`）：`Abstract` 单行 `<input>`（`memory-abstract`；粘贴进来的换行换成空格）、`Details` 多行（`memory-details`），内容是这一条现在的 abstract 与 `## Details` 原文；`Save`（`memory-save`）、`Cancel` | 编辑；Save；Cancel |
| 新增 | 你点了 `New entry` | 右栏打开空的同一个表单；种类按当前分节、层按当前的 `User` / `Project`（事实也一样）；中栏的选中去掉（临时，走查时可以改） | 编辑；Save；Cancel |
| 表单检查 | 你点了 `Save` | 有问题时在字段下方显示、不发命令：`Abstract is required.`（去掉首尾空白后为空）、`Abstract must be at most 200 characters.`、`Details must be at most 4,000 characters.` | 修改 |
| 保存中 | `memory.save` 还没返回 | `Save` 不可用（临时，走查时可以改） | — |
| 已保存（编辑） | `memory.save { cwd, layer, kind, id, abstract, detail }` 返回 `error: null` | 表单关闭，详情按新内容重读：`Learned`、`Added by Mori` 的条目变为 `You said`（`source: user`，§6.4）；`History` 多一行 `<Mon D> · You: Edited on the Memory page`；`Revisions` 多一条 `You · Changed <KIND>: …`（§6.5）；F8 记 `Edit memory entry` | — |
| 已保存（新增） | 同上，不带 `id`；结果的 `id` | 新条目加在列表末尾（`You said`），选中它，右栏是它的详情；`Revisions` 多一条 `You · Added <KIND>: …`；F8 记 `Save memory entry` | — |
| 保存失败 | 结果的 `error` | 详情顶部 `Couldn’t save: <原因>`（`memory-error`），表单与文字保留 | 修改后再 Save；Cancel |
| Cancel | 你点了 `Cancel` | 不问（`Cancel` 不在规格 §10.1 要先问的操作里），丢掉表单里的字：编辑时回到详情，新增时右栏关闭 | — |
| 编辑中收到 `mori.memory_changed` | 增强运行或对话里的 memory 工具改了同一层 | 不重读，表单和文字保留；保存时以最后一次写入为准，前后两次写入都留在 `Revisions` 里，可以回滚 | Save |

### 离开确认

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 有未保存的改动时离开 | 表单里的字与打开表单时不同（临时，走查时可以改），你做了下面列出的任一操作 | 确认框（`leave-dialog`，同 Customize 的 Instructions（用户级 AGENTS.md，2026-10-26 前在设置页）的确认框与焦点规则，标题由登记的检查给出）：标题 `Discard changes to this entry?`（临时，规格 §12），说明 `Your edits haven’t been saved. Leaving now discards them.`，按钮 `Discard`、`Keep editing`；焦点在 `Keep editing`，Esc 等于 `Keep editing` | Discard；Keep editing |
| Discard | 你点了 `Discard` | 表单关闭、丢掉改动，然后照常做你刚才的操作 | — |
| Keep editing | 你点了 `Keep editing` 或按 Esc | 留在表单，什么都不变（你点的会话不打开、已归档的不恢复），焦点回到表单 | 继续编辑 |
| 跟随的项目变了时 Keep editing | 分屏换焦点等让跟随的项目改变，你在确认框选了 `Keep editing` | 页面留在原来的项目；表单关闭（保存或 `Cancel`）之后再跟随焦点会话的项目（临时，走查时可以改） | 继续编辑 |
| 没有改动 | 表单里的字与打开时相同 | 不问，直接做 | — |

要先问的操作（§10.1）：换右栏内容的操作（选另一行、`New entry`、换层、换分节、详情里的 `[[slug]]` 与 `Linked from`、`History` 与 `Last change` 的链接、关闭详情）、
`Jump to source`、`Edit in Customize`（2026-10-26 改，原来是 `Edit in Settings`），以及已有的离开入口（`Back to app`；侧栏的会话、项目行的 +（2026-10-26 起取代 `New session`）、`Open folder…`、`Customize`、`Settings`、Ctrl+N，同 Customize 的 Instructions 的列表；
分屏换焦点导致跟随的项目改变）。`Linked from` 与关闭详情两项是本表加的（临时，走查时可以改）。

## 删除

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 确认框 | 你点了 `Delete…` | 标题 `Delete “<abstract>”?`，说明 `You can roll it back from Revisions.`，按钮 `Delete` / `Cancel`；焦点在 `Cancel`，Esc 等于 `Cancel`（同 models-settings.md 的确认框，临时，走查时可以改） | Delete；Cancel |
| 删除中 | `memory.delete { cwd, layer, id }` 还没返回 | 确认框里显示 `Deleting…`，`Delete` 与 `Cancel` 不可再点（共用确认框的写法：`Deleting…` 是按钮上面的一行，按钮文字不变，临时，走查时可以改）；Esc 不关 | — |
| 已删除 | 返回 `error: null`；随后的 `mori.memory_changed` | 确认框关闭；这一行从列表消失，详情关闭，焦点回到列表；`Revisions` 多一条 `You · Deleted <KIND>: …`；F8 记 `Delete memory entry` | 在 `Revisions` 回滚 |
| 删除失败 | 返回 `error`（例如 `This entry no longer exists.`） | 确认框关闭（临时，走查时可以改），详情顶部 `Couldn’t delete: <原因>` | 再试 |
| 确认框开着时后台进程退出 | 界面的后台进程状态 | 确认框关闭（没在删除中时；删除中时等 `memory.delete` 失败后关闭，按“删除失败”），`Delete…` 不可用，悬停 `Mori’s background process crashed. Restart it to continue.`（§10.10）；`Restart` 之后确认框不自己再打开（临时，走查时可以改） | `Restart` 后再点 `Delete…` |

删除从不因预算被拒绝（§6.3）。

## 移动

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 提升到用户级 | `Project` 层的条目 | `Move to user level`（`memory-move`） | 点击（不确认，规格没有确认框）：`memory.move { cwd, from: 'project', id }` |
| 放回本项目 | `User` 层的条目，有跟随的项目 | `Move to this project`（`memory-move`） | 点击：`memory.move { cwd, from: 'user', id }` |
| 移动中 | `memory.move` 还没返回 | 按钮不可用（临时，走查时可以改） | — |
| 已移动 | 返回 `{ error: null, revision, id }`；随后的 `mori.memory_changed`（两层） | 这一条离开当前层：列表不再有它，详情关闭，焦点回到列表（按“数据何时读”的规则；不自动换到目标层，临时，走查时可以改）。目标层末尾多一条，`You said`（你提升的算你说的，§6.1），修改日期是当天，`History` 多一行 `<Mon D> · You: Moved to user level` / `Moved to this project`；两层的 `Revisions` 各多一条 `You · Moved to user level: …` / `You · Moved to this project: …`；F8 记 `Move to user level` / `Move to this project` | 在 `Revisions` 回滚 |
| 移动失败 | 返回 `error`：预算（提升时对每个有这一种条目的项目逐一检查，原文写出第一个超出的项目）、`This entry no longer exists.` | 详情顶部 `Couldn’t move: <原因>`；条目不变 | — |

## 依据回到原位置

M7 的 `jumpBack` 推广为按依据跳（§10.2）。只在你点 `Jump to source` 时检查（不预先读会话、不读文件）；检查的结果只记在这次运行的内存里（同 M7）。
状态写在这一项依据下面的一行（`memory-jump-status`，位置临时，走查时可以改）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 会话依据，会话在侧栏里 | 依据的 `session`（会话文件路径）+ `entry`；侧栏的会话列表；`session.read { sessionFile, anchor: entry }` 的 `anchor`（这个条目或它之上最近的一条你的消息或助手回复，不含程序投递；在完整的当前分支上找，会话正在生成、文件很大时一样，§8） | 打开那个会话（已归档的先恢复；分屏时放进焦点所在的一栏，同 M7），在对话流里找到含这个条目的那一轮（用户消息、助手回复或其中的工具调用），滚过去高亮（同 M7 的时长，约 4 秒）；F8 记 `Jump to source from Memory` | — |
| 正在检查 | `session.read` 还没返回 | 按钮 `Opening…`，不可再点 | — |
| 条目不在当前分支 | `session.read` 的 `anchor` 为 `null`（会话当前分支上没有这个条目）；或打开会话后对话流里找不到那条消息 | 留在记忆页，状态行 `This message is no longer in the session.` | — |
| 会话已删除 | 会话列表读完了、里面没有它，本次也没有打开它；或 `session.read` 报会话文件不在（`Session file not found…`） | 状态行 `Session deleted`，`Jump to source` 不可用（同 M7） | — |
| 会话列表没读好 | 侧栏的会话列表还在读或读取失败，会话也没有打开 | 同 M7：`Sessions are still loading. Try again in a moment.` / `Couldn’t load sessions, so the original session can’t be opened.`（列表读好了却打不开时 `The original session isn’t in your session list.`）；再点时清掉 | 稍后再点 |
| 读会话文件出别的错 | `session.read` 的错误（例如文件被占用的 `EBUSY`） | 状态行原文 | 再点 |
| 打开失败 | 会话打开报错 | 同 M7：中栏是这个会话，会话横幅 `Failed to open session: <原文>` | 在侧栏再点这个会话 |
| TaskBoard 实例会话 | 依据的 `session` 是 `<userData>\teams\<会话 id>\sessions\` 下的文件（§3、§7.3；见“需要规格回答”） | 不打开（实例会话不进侧栏），状态行 `This is a background agent’s session, which can’t be opened.` | — |
| `entry` 为 null | 分开时立项记的依据（那时消息还没写进用户会话，§7.3） | 打开会话，不定位；`Opened the session; the exact message wasn’t recorded.`（显示在哪里见“需要规格回答”） | — |
| 反馈依据，文件还在 | 依据的 `feedback`（文件名，不含目录）；经 `mori:read-file` 读到的那份反馈记录 | 跳到那条反馈的来源，同 M7 的三种跳法：回复里的选区、整条回复、文件里的选区（[v0 review.md](../../v0/screens/review.md)“回到原位置”） | — |
| 反馈依据，跳不过去 | 同 M7 | 同 M7 的各条：`This response is no longer in the session.`、`Session deleted`、`The session wasn’t saved, so there’s no source to jump to.`、阅读器顶部 `Source changed · Attached text:`、`File not found`、会话列表没读好的三句 | 同 M7 |
| 反馈文件不在了 | 反馈文件被删（`mori:read-file` 报文件不存在） | 状态行 `The feedback file was removed.` | — |
| 反馈文件读不出 | `mori:read-file` 的其他错误，或内容不合反馈记录的格式（`StoredFeedbackSchema`） | 状态行原文（带文件路径） | 再点 |
| 后台进程退出 | 界面的后台进程状态 | `Jump to source` 不可用，悬停 `Mori’s background process crashed. Restart it to continue.` | — |
| 跳转未完成时离开记忆页 | 你点了 `Back to app`、侧栏等 | 跳转被取消：不切会话、不显示状态（M7 写死的 `view === 'review'` 改为发起跳转时的页面） | — |
| 有未保存的编辑 | — | 先出离开确认框 | — |
| 回到记忆页 | 跳转后在侧栏点 `Memory` | 层、分节、选中的条目与它的详情还在（同 M7“选中的还是这一条”，临时，走查时可以改） | — |

依据跳到会话后中栏换成那个会话；`memory-jump-status` 只在跳不过去时有字（`entry` 为 null 的那一句除外）。

## AGENT

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 读取中 | `agents.get` 还没返回 | `Loading…`（临时，走查时可以改） | — |
| 读取失败 | `agents.get` 报错 | 原文（同 Customize 的 Instructions 一节的“读取失败”，临时，走查时可以改） | 换分节再回来 |
| 用户级一行 | `agents.get` 的 `effectivePath`、`userTokens` | 第一行（`memory-agent-file`）：agentDir 里生效的那个文件的路径、`<n> tokens`（1 时 `1 token`，1000 起按千分位写，2026-10-26 改）；`Edit in Customize`（2026-10-26 改） | Edit in Customize：打开 Customize，落在最后一节 Instructions（有未保存的编辑时先问；操作记录 `Open Customize → Instructions`） |
| 用户级没有生效的文件 | `effectivePath` 为 null | 第一行写 `No user-level AGENTS.md`（临时，走查时可以改），仍有 `Edit in Customize` | Edit in Customize |
| 项目的文件（`Project`） | `agents.get { sessionId: 跟随的会话 }` 的 `loaded`，按 pi 的顺序 | 每个文件一行（`memory-agent-file`）：路径、`<n> tokens`；`Open in default app`（同 Customize 的 Instructions 一节） | Open in default app |
| `User` 层 | — | 只列用户级那一行 | Edit in Customize |
| 合计 | `agents.get` 的 `total`（没有会话时就是 `userTokens`） | 下面一行 `<total> / 2,000 tokens`（2026-10-26 改：原来是 500；数字按千分位写）（`memory-agent-total`；合计等于各行之和） | — |
| 超出 | `total` > 2000（负责人 2026-10-26 定，`AGENTS_LIMIT`） | 合计为警告色，加 `Over 2,000 tokens. Mori doesn’t shorten AGENTS.md; edit the files to keep prompts short.`（不截断仓库里的文件，proposal §5.2） | 编辑文件 |

- token 用 `estimateMemoryTokens`，每个文件单独算，文字是 pi 加载结果里的内容（已去 BOM），不含 pi 加的开头一句与包装标签（§10.3）。
- `AGENT` 不是记忆：没有用量一行、`New entry`、详情；记忆页不编辑 AGENTS.md（用户级到 Customize 编辑，项目的文件在默认程序里打开）。

## Revisions

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 列表 | `memory.revisions { cwd, layer }` 的 `revisions` | 时间倒序，每行（`revision-row`，`data-id`）：标题（§6.5 的原文，例如 `STRATEGY enhancement · Oct 23`、`Mori · Added Facts: …`、`You · Moved to user level: …`、`Rolled back: …`）、时间 `<Mon D> <hh:mm>`、改动数 `Added 1, changed 2`（计数为 0 的不写，都为 0 时 `No changes`）、状态标记 | ↑ ↓ 在行之间移动；Enter 或点击选中，右栏打开详情（有未保存的编辑时先问） |
| 状态标记 | 行的 `status`、`rollbackOf` | `status` 为 `running` 时 `Running`，为 `failed` 时 `Failed`；回滚产生的（`rollbackOf` 不为 null）标 `Rollback` | — |
| 只列最新 200 条 | §12 | 不分页、不提示更早的（临时，走查时可以改） | — |
| 没有修订 | `revisions` 为空 | `No revisions yet.`（临时，走查时可以改） | — |
| 读取中 / 重读 / 读取失败 | 同前四节 | 同前四节：`Loading…`；`Couldn’t load memory: <原因>` | 同前四节 |
| 详情 | `memory.revisions { cwd, layer, id }` 的 `revision` | 右栏 `revision-detail`：标题；一行时间与谁 `<Mon D> <hh:mm> · <You\|Mori\|Enhancement\|Rollback>`（写法临时，走查时可以改）；增强运行另有一行 `Day <Mon D> · <n> sessions · <m> feedback · <k> tokens`（单数 `1 session`、`1 token`；token 写法同增强状态行：不到 1000 写 `<n> tokens`，1000 起写 `<n>k tokens`）；运行中（`run.tokens` 为 null）时不写 token 那一段（临时，走查时可以改） | 关闭 |
| 每处改动 | `revision.changes` | 每处一块：`<Added\|Changed\|Deleted\|Moved> · <KIND> · <abstract>`（增强任务把 Mori 记的条目移到另一种时 `Changed · <原 KIND> → <目标 KIND> · <abstract>`，对照里 `kind:` 一行不同、`## Revisions` 多一行 `Moved from <KIND> to <KIND>: …`；2026-10-26，规格 §6.9）；下一行是依据（`Evidence: <原文>`）或说明（`Note: <原文>`），有时才显示；改动前后的对照（M4 的 diff 组件比较 `before` 与 `after` 两份 detail 文件；新增时前面为空，删除时后面为空，移动时前面是原层、后面是目标层的文件） | 展开、收起对照（同 M4，临时，走查时可以改） |
| `Notes` | `revision.notes`（增强运行最后一条回复） | 小标题 `Notes`，按 Markdown 渲染（同 Details）；没有时不显示 | — |
| `Roll back this revision` | — | 按钮 `Roll back this revision`（`revision-rollback`）；一键，不确认（proposal §6.4） | 点击：`memory.rollback { cwd, layer, id }` |
| 不能回滚 | `status` 为 `running`；或 `counts` 全为 0（没有改动） | 按钮不可用（规格没给悬停文字） | — |
| 回滚中 | `memory.rollback` 还没返回 | 按钮不可用（临时，走查时可以改） | — |
| 已回滚 | 返回 `{ error: null, revision }`；随后的 `mori.memory_changed` | 列表最上面多一条 `Rolled back: <被回滚的标题>`（标 `Rollback`），那次改过的条目恢复原样（`source` 随之恢复）；选中仍是被回滚的那一次（按“数据何时读”的规则）；F8 记 `Roll back revision` | 回滚新的那条（可以再回滚） |
| 回滚失败 | 返回 `error` | 按钮附近 `Couldn’t roll back: <原因>`（位置临时，走查时可以改）；什么都没改 | — |
| 运行结束 | `endRun` 之后的 `mori.memory_changed` | `Running` 那一行变为结束状态（`Failed` 或不标），计数更新 | — |

回滚失败的原因（内核原文，§6.6）：`“<abstract>” changed later (<那次修订的标题>). Roll back that revision first.`（找不到那次修订时 `“<abstract>” changed later.`）、
§6.3 的预算原文、`This revision’s run is still going.`、`This project’s memory folder belongs to <cwd>.`。回滚不动增强的水位。

## 数据何时读

不监视文件、不轮询（§0）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 清空并读 | 打开记忆页、换层、换分节、跟随的项目改变 | 不显示别的项目、别的层或分节的结果；前四节读 `memory.list`，`AGENT` 读 `agents.get`，`Revisions` 读 `memory.revisions`；读完之前 `Loading…` | — |
| 收到这一层的 `mori.memory_changed` | 事件的 `layers` 含当前的层（`Project` 时事件的 `cwd` 是跟随的项目） | 重读当前分节：前四节在 `kinds` 含这一种时读 `memory.list`，`Revisions` 读 `memory.revisions`；`AGENT` 不读。上一次的列表、选中与滚动位置留着，标题旁 `Loading…` | — |
| `Project` 时只改了用户级 | 事件的 `layers` 只有 `user`，`kinds` 含当前这一种 | 前四节同样重读 `memory.list`（`Project` 的用量含用户级这一种，临时，走查时可以改；见“需要规格回答”）；`Revisions` 不读 | — |
| 详情开着、不在编辑 | 同上 | 一起重读：条目读 `memory.get`，修订读 `memory.revisions { id }`；结果为 null 时关闭详情，焦点回到列表 | — |
| 编辑中 | 同上 | 不重读（上面“编辑与新增”） | — |
| 已经打开的会话 | §5.2 | 记忆页上改的条目只对之后新建、重新打开的会话生效；已经打开的会话不变 | — |

## 后台进程退出时

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 已在记忆页 | 后台进程退出 | 页面保留最后读到的内容（退出时还没返回的 `memory.list`、`memory.get`、`memory.revisions`、`agents.get`、`enhance.get` 不把列表、详情、状态行换成错误；标题旁的 `Loading…` 去掉）；所有操作不可用（换层、换分节、选行、`New entry`、`Edit`、`Save`、`Delete…`、移动、`Jump to source`、`Edit in Customize`、增强一块、回滚），悬停 `Mori’s background process crashed. Restart it to continue.`；页面顶部是已有的全局退出横幅（`Mori’s background process crashed · Unfinished responses were interrupted` 与 `Restart`，同 M7 工作回顾），不另加 | `Restart`；`Back to app`（照常可用，临时，走查时可以改） |
| 编辑中退出 | 同上 | 表单和文字保留，`Save` 不可用 | — |
| 重新连上 | 你点了 `Restart`，后台进程重新连上 | 重读当前层、分节和开着的详情；在 `Project` 时先等跟随的会话打开好（同 Customize） | 照常 |

## 反例

- 左栏没有 `Review`；没有反馈列表、反馈导出与反馈的 `Resolve`（反馈出现在条目的 Evidence 与修订里，§10.7）。
- 读不出来的条目不能选中、不进 prompt。
- 记忆页上加的条目不进已经打开的会话（MEM-04）；新建的会话有它。
- 别的项目的条目不出现在 `Project` 里，换项目时不先显示上一个项目的列表。
- 删除不出预算错误；回滚、移动、保存超出预算时什么都不写。
- 回滚不弹确认框；运行中、没有改动的修订不能回滚。
- 跳转没完成就离开记忆页，不会切到那个会话。
- 有未保存的编辑时收到 `mori.memory_changed`，表单里的字不被冲掉。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：项目没了时回到 `User`；第一次打开的层与分节（`Project` 或 `User`、`Facts`）、再次打开回到上次的层与分节；
换项目时回到的分节按项目记住、没看过的项目保持当前分节；跟随的项目变了而你选 `Keep editing` 时留在原来的项目、表单关闭后再跟随；
读不出来的条目排在条目之后；前四节读取失败没有重试按钮（换层、换分节时再读）；详情读取中 `Loading…`、详情的 × 与 `Close details`；
`[[slug]]` 与 `Linked from` 点了之后中栏换到那一条的层与分节并选中它；`Linked from` 每行 `<KIND> · <abstract>`；
`History` 里修订的时间写法、两者都没有时不显示；写入失败的提示在下一次操作时消失；
新增时去掉中栏的选中；保存中、移动中、回滚中按钮不可用；“有未保存的改动”指表单里的字与打开时不同；`Linked from` 与关闭详情也要先问；
删除确认框的焦点在 `Cancel`、Esc 等于 `Cancel`，删除失败时确认框关闭，删除中 `Deleting…` 是按钮上面的一行（共用确认框），
后台进程退出时确认框关闭、`Restart` 后不自己再打开；移动后不自动换到目标层；`memory-jump-status` 的位置；跳转后回到记忆页时选中的还在；
反馈依据经已有的 `mori:read-file` 读反馈记录，读不出时状态行写原文；`Project` 时只改用户级的 `mori.memory_changed` 也重读前四节；
`AGENT` 的读取中与读取失败、用户级没有生效文件时的 `No user-level AGENTS.md`；`Revisions` 的 `No revisions yet.`、只列 200 条不提示、详情里“时间 · 谁”的写法、
运行中不写 token、回滚失败提示的位置、对照可以展开收起、回滚后选中不变；后台进程退出时 `Back to app` 照常可用。

规格自己标“临时”、登记在规格 §12 的：离开确认框的标题 `Discard changes to this entry?`。

## 需要规格回答

1. **界面怎么认出 TaskBoard 实例会话**：§10.2 第二行按“`session` 是 TaskBoard 实例会话”分支。本表按路径在 `<userData>\teams\<会话 id>\sessions\` 下判断；
   界面只知道 agentDir（`<userData>\pi`），由它推出 `<userData>`。如果要由后台进程标出（例如存下依据时记一个标志），需要规格写明。
2. **`Opened the session; the exact message wasn’t recorded.` 显示在哪里**：这一行写在“跳到哪里”一栏，跳转时中栏已经换成那个会话，记忆页上的 `memory-jump-status` 看不到。
   本表按规格写在记忆页的状态行（回到记忆页时看得到）；如果要在会话里提示，需要规格给位置。
3. **只改用户级时 `Project` 的用量**：`Project` 的用量含用户级这一种，但 §10.1 只在收到“这一层”的 `mori.memory_changed` 时重读；
   只改用户级的事件（`layers: ['user']`）按字面不重读 `Project`，用量与 `User <u>` 会是旧的，直到换层、换分节。本表让 `Project` 的前四节也对这样的事件重读（`kinds` 含这一种时），需要规格确认。
4. **修订详情每处改动的 `<abstract>` 从哪里来**：`RevisionChange`（§8）没有 abstract 字段。本表按改动后的 detail 文件（`after`；删除时 `before`）frontmatter 的 `abstract` 取；
   需要规格确认，或给 `RevisionChange` 加上 abstract。

反馈依据的反馈记录：§10.8 让主进程的 `mori:review-*` 去掉反馈部分，本表用已有的阅读器通道 `mori:read-file` 只读地读 `<userData>\feedback\<文件名>`，不另加通道。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 左栏入口 | `data-testid="nav-memory"` |
| 页面 | `section.memory-page[data-testid="memory-page"]` |
| 层 | `memory-scope-user`、`memory-scope-project` |
| 分节 | `memory-section-<facts\|taste\|strategy\|review\|agent\|revisions>`，`aria-pressed` |
| 用量、最近一次修订、新增 | `memory-usage`、`memory-last-change`、`memory-new` |
| 列表 | `memory-list`；行 `memory-row`（`data-id`、`data-source`）；读不出来的 `memory-broken` |
| 条目详情 | `aside.right-panel[data-testid="memory-detail"]`；`memory-evidence`、`memory-jump`、`memory-jump-status`、`memory-backlinks`、`memory-history`、`memory-error`；按钮 `memory-edit`、`memory-delete`、`memory-move` |
| 表单 | `memory-form`，内含 `memory-abstract`、`memory-details`、`memory-save` |
| 离开确认 | `data-testid="leave-dialog"`（沿用 AGENTS.md 一节的，v0 起） |
| 删除确认框 | 规格没给标识：`role="dialog"`，按标题文字找 |
| AGENT | `memory-agent-file`、`memory-agent-total` |
| Revisions | 行 `revision-row`（`data-id`）；详情 `revision-detail`；`revision-rollback` |
