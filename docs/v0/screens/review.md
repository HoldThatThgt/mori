# 工作回顾（Review，M7）

依据：方案 5.14、5.1（左栏导航"Review"、独立页面顶部"Back to app"）、第 4 节"选区反馈、F8 界面问题 · Mori · 记录、收件箱、导出"、
第 6 节（`feedback.ts`；Mori 自己只保存界面状态、反馈和 F8 报告）。
读的记录：对内容的反馈是 [selection.md](selection.md) "反馈"存下的 JSON；界面问题是 [f8.md](f8.md) "保存的内容"里的报告。
回到原位置照 [selection.md](selection.md) "回到原位置"。

> v1 已取代本文（docs/specs/memory.md §10.1、§10.8）：左栏"Review"换成"Memory"，工作回顾页由记忆页取代，状态表见
> [../../v1/screens/memory-page.md](../../v1/screens/memory-page.md)；本文只是 v0 的记录。
> 界面问题（列表、详情与截图、"Resolve"/"Reopen"、"Hide resolved"、"Export as Markdown…"、"Open folder"）挪到设置页第三节"UI issues"，文字不变，
> 后台进程退出时照常可用；测试标识 `review-*` 改为 `issues-*`，主进程通道 `mori:review-*` 去掉反馈部分、改名 `mori:issues-*`；
> 状态表见 [../../v1/screens/settings-issues.md](../../v1/screens/settings-issues.md)。
> 对内容的反馈不再单独成列表，没有导出和已处理：开了增强的项目由增强任务作为依据读取，反馈出现在条目的 Evidence 和修订里（§10.7）；
> 回到原位置推广为记忆页依据的"Jump to source"（§10.2）；F8 保存后的"View in Review"改为"View in Settings"（§10.9）。

2026-10-21 负责人决定（开工时问的）：

- **三级结构**，与现有界面一致：左栏顶层入口"Review"；中栏是列表，每条一段摘要；点一条在右栏打开详情。
- **已处理**是你自己打的勾，意思是"这一条我处理过了"（例如问题在下一轮改好了）；只让它变淡或不列出，不删除任何东西。
  用"Hide resolved"开关筛掉：默认全部显示，已处理的变淡并标"Resolved"；打开开关后不列出；开关的选择重启后还在。
- **已处理的标记**记在 Mori 本机的界面状态里（与已归档的会话相同），反馈和报告文件不改。
- **界面问题的数据在一个文件夹里**：`<userData>\ui-issues\`，这台电脑的这个用户一份，所有项目和会话共用，每份报告的 Markdown 和截图都在里面。
  要交给别人时把这个文件夹打成一个 zip，或者用"Export as Markdown…"。导出只写一个 `.md`，截图链接指向原来的 PNG，不复制截图。

## 入口

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 左栏"Review" | — | "Customize"下面一项"Review"（收起为图标栏时是图标按钮，悬停显示"Review"）；在工作回顾页时高亮 | 打开工作回顾 |
| 后台进程已退出 | 后台进程退出 | "Review"照常可用（读的是本机文件，不经过后台进程）；页面上方是后台进程退出的横幅（同设置页、工具页） | 同下；只有"Jump to source"不可用，说明"Mori’s background process crashed. Restart it to continue." |
| 反馈已记录 | 反馈表单保存成功（selection.md "已记录"） | "Saved · View in Review"，"View in Review"是链接；表单仍约 3 秒后关闭 | 点链接：打开工作回顾的"Feedback"一节，选中刚记下的这一条 |
| 界面问题已保存 | F8 报告框保存成功（f8.md "已保存"） | 报告框里"Show in Explorer"旁边多一个"View in Review"（首次启动、读取连接中或读取连接失败的页面上没有工作回顾，不显示它） | 点它：关闭报告框，打开工作回顾的"UI issues"一节，选中这一份 |

## 页面（中栏）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 顶部 | — | "Back to app"；标题"Review" | Back to app（恢复分屏、滚动位置、右栏的文件、草稿，与设置页、工具页相同） |
| 分节 | — | 两个切换按钮："Feedback"、"UI issues"，各带未处理的条数（读屏名称"Feedback, 3 unresolved"；为 0 时不显示数字，读屏名称仍是"Feedback, 0 unresolved"，临时默认值）；当前分节按下 | 切换分节（选中的记录、开关、滚动位置分节各自记住，直到重启） |
| 工具行 | — | "Hide resolved"开关；"Export as Markdown…"；"Open folder" | 见下 |
| 读取中 | 主进程在读两个文件夹 | "Loading…"（第一次读在列表的位置；之后重新读时上一次的列表留着、滚动位置不变，"Loading…"在标题旁边）；读完之前"Export as Markdown…"不可用 | Back to app |
| 读取失败 | 主进程读文件夹报错（文件夹不存在不算错，算空） | 原文和"Retry" | Retry |
| 空 | 文件夹不存在或没有记录 | 反馈："No feedback yet. Select text in a response or the file viewer and click “Feedback”, or use “Give feedback” under a response."界面问题："No UI issues yet. Press F8 to report one." | — |
| 都已隐藏 | "Hide resolved"开着，这一节的记录都已处理 | "No unresolved records · N resolved records hidden"（1 条时"1 resolved record hidden"）和链接"Show resolved" | Show resolved（关掉"Hide resolved"） |
| 列表 | 读到的记录 | 按记录的时间从新到旧，每条一行摘要（见下）；没有分页 | ↑ ↓ 在行之间移动焦点；Enter 或点击打开详情 |
| 何时重新读 | 打开工作回顾；页面开着时你保存了新的反馈或 F8 报告；点"Retry" | 新记录出现在最上面；不监视文件夹，别的程序写进来的要下次打开才看到 | — |

**一行摘要**

| 记录 | 必须可见 |
| --- | --- |
| 反馈 | 你的期望（最多 2 行）；原文的第一行（截断，引用样式）；来源和时间："<会话名> · Selection in response" / "<会话名> · Whole response" / "<文件> · lines a–b"（一行时"line N"），时间"10-20 14:03"（本地时间，不是今年的带年份"2025-10-20 14:03"） |
| 界面问题 | "What went wrong"（最多 2 行；没有填写时用"What you expected"）；时间；没有截图时标"No screenshot" |
| 已处理 | 整行变淡，标"Resolved" |
| 选中 | 整行高亮（右栏显示它的详情） |
| 读不出来 | 一行"Couldn’t read the record <文件名>"和原文（JSON 坏了、字段不对，或报告缺"## What went wrong"等标题）；可以选中、标已处理 |

会话名用侧栏现在的名字（改过名的显示新名字）；找不到会话时用记录里的名字。文件按反馈时会话的工作目录显示相对路径，不在工作目录里的显示完整路径。

**只认 Mori 写的文件**：反馈文件夹里只列 `.json`，界面问题文件夹里只列名字是报告时间格式（`YYYY-MM-DD-HHmmss.md`，同一秒的 `-2`、`-3`）的 `.md`；
别的文件（例如你导出到这个文件夹里的 `.md`、zip）不列出。

## 隐藏已处理与已处理

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 开关关着（默认） | 本机界面状态 | 全部记录；已处理的变淡并标"Resolved" | 打开开关 |
| 开关开着 | 你打开了开关（两个分节共用一个开关，重启后保留） | 已处理的不列出；分节上的数字不变（一直是未处理的条数） | 关掉开关 |
| 标为已处理 | 你在详情里点了"Resolve" | 这一行变淡并标"Resolved"；开关开着时这一行马上不列出，右栏的详情还在，按钮变成"Reopen" | Reopen |
| 标为未处理 | 你在详情里点了"Reopen" | 回到平常的样子 | Resolve |
| 保存 | 本机 `localStorage`（`mori.review`），按"文件夹/文件名"记 | 重启后还在；本机存储被清掉时全部回到未处理 | — |

## 详情（右栏）

右栏的宽度与会话的右栏共用（拖动分隔线一样保存）；窗口窄于 800px 时浮在中栏上层（同会话的右栏）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 没有选中 | 刚打开页面、关了详情 | 不显示右栏，中栏占满 | — |
| 反馈 | 你选了一条反馈 | 标题"Feedback"和 ×（读屏名称"Close details"）；时间（完整）；来源："Session"（会话名）、"Scope"（"Selection in response" / "Whole response"；文件里的反馈这一项叫"File"，写"<文件> · lines a–b"）、"Working directory"（没有记下时"(not recorded)"）；"What you hoped for"全文；"Quoted text"全文（太长时在框里滚动）；"Jump to source"；"Resolve"或"Reopen" | Jump to source；Resolve / Reopen；关闭（×） |
| 界面问题 | 你选了一份报告 | 标题"UI issues"和 ×；时间；"What went wrong"、"What you expected"全文；"Screenshot"下面是截图（按右栏宽度缩小）或"Couldn’t capture a screenshot: <原文>"；可以展开的"Current view""Recent activity""Versions"；"Show in Explorer"；"Resolve"或"Reopen" | 放大截图；展开；Show in Explorer（资源管理器里选中这份报告）；Resolve / Reopen；关闭 |
| 截图读取中 / 读不出 | 主进程读 PNG | "Loading screenshot…" / "Couldn’t load the screenshot: "+ 原文（例如 PNG 被删了） | — |
| 放大截图 | 你点了截图（或焦点在截图上按 Enter） | 浮层里按原尺寸显示截图，大于窗口时缩到窗口内；"Close" | Esc、"Close"或点截图外面关闭，焦点回到截图 |
| 读不出来的记录 | 你选了读不出来的一行 | "Couldn’t read the record <文件名>"、原文；"Show in Explorer"；"Resolve"（或"Reopen"） | 同左 |
| 记录不在了 | 重新读取后列表里没有它了（文件被删了） | 关闭详情 | — |

## 回到原位置（反馈）

只在你点"Jump to source"时检查（不预先读会话、不读文件）。打开会话与在侧栏点它相同：已经开着的直接显示，已归档的先恢复，
分屏时放进焦点所在的一栏；之后的滚动、高亮照 M4 点芯片回到原位置。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 回复里的 | 锚点：会话文件、条目 id（反馈时回复还在生成就没有 id，用消息时间） | 先确认那条回复还在：会话开着时看对话流，没开着时读会话文件（`session.read`）；在的话中栏换回会话，滚到那条回复，高亮约 4 秒（选区高亮原文，整条回复高亮整轮） | 在侧栏点"Review"回来，选中的还是这一条 |
| 文件里的 | 锚点：路径、内容哈希、行范围；反馈时所在的会话 | 打开反馈时所在的会话，右栏打开阅读器：哈希没变滚到原来的行，变了找原文，找不到时阅读器顶部"Source changed · Attached text:"；文件不在了显示"File not found"（同 M4） | 同上 |
| 正在检查 | 读会话文件中 | 按钮显示"Opening…"，不可再点 | — |
| 回复不在了 | 会话当前的分支上找不到这条回复 | 留在工作回顾，详情里"This response is no longer in the session."；引用的原文仍在详情里 | — |
| 原会话已删除 | 会话列表读完了、里面没有它，本次也没有打开它；或读会话文件时文件不在 | 详情里"Session deleted"，"Jump to source"不可用；引用的原文仍在 | — |
| 原会话没有保存 | 记录里没有会话文件 | 详情里"The session wasn’t saved, so there’s no source to jump to."，按钮不可用 | — |
| 会话列表没读好 | 侧栏的会话列表还在读或读取失败，原会话也没有打开 | 留在工作回顾，详情里"Sessions are still loading. Try again in a moment." / "Couldn’t load sessions, so the original session can’t be opened."（列表读好了却打不开时"The original session isn’t in your session list."） | 稍后再点"Jump to source"（成功后说明消失） |
| 打开失败 | 会话打开报错 | 中栏是这个会话，会话横幅"Failed to open session: <原文>"（同在侧栏点它） | 在侧栏再点这个会话重试（横幅上没有重试按钮，同 [sessions.md](sessions.md)"新建或打开失败"） |
| 后台进程已退出 | — | 按钮不可用，说明"Mori’s background process crashed. Restart it to continue." | — |

检查的结果只记在这次运行的内存里。

## 导出为 Markdown

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 可以导出 | 这一节有列出的记录 | "Export as Markdown…"可用 | Export as Markdown… |
| 没有可导出的 | 这一节一条都没列出（空，或都已隐藏） | 按钮不可用 | — |
| 选位置 | 你点了导出：主进程的保存对话框 | 标题"Export as Markdown"（两节相同）；默认文件名 `feedback-<YYYY-MM-DD>.md` / `ui-issues-<YYYY-MM-DD>.md`（与记录文件夹同名），默认放在"文档"里 | 保存；取消（什么都不变） |
| 已导出 | 主进程写完文件 | 工具行下面"Exported N records to <路径>"（1 条时"Exported 1 record to <路径>"）和"Show in Explorer" | Show in Explorer（资源管理器里选中导出的文件） |
| 导出失败 | 主进程写文件报错 | "Couldn’t export: "+ 原文 | 再导出 |

**导出哪些**：这一节现在列出的记录（"Hide resolved"开着时不含已处理的），顺序与列表相同，每条注明"Unresolved"或"Resolved"。

**导出的内容**（临时默认值，见 defaults.md）：

- 开头：`# Feedback` 或 `# UI issues`，下一行导出时间、条数（"Exported <时间> · N records: a unresolved, b resolved"；只有一条时"1 record"）。
- 反馈每条一节 `## <序号>. <时间> · <Unresolved/Resolved>`：来源（`- Session:` 会话名，没有时 `Untitled session`；
  `- Scope:` "Selection in response" / "Whole response" / "File <完整路径>, lines a–b"；`- Session file:`，没有时 `(not saved)`；
  `- Working directory:`，不知道时 `(unknown)`；`- Record file:`）、`### What you hoped for`、`### Quoted text`（每行前加 `> `）。
- 界面问题每条一节 `## <序号>. <时间> · <Unresolved/Resolved>`：`- Report file: <完整路径>`，然后是报告原来的各节（`### What went wrong`、
  `### What you expected`、`### Screenshot`、`### Current view`、`### Recent activity`、`### Versions`，标题降一级）。截图写成
  `![Screenshot](<链接>)`，链接是从导出文件所在的文件夹到原来那张 PNG 的相对路径
  （每一段按网址编码；导出到 `ui-issues` 文件夹里时就是文件名，连同文件夹打成 zip 也能看）；不在同一个盘上时写 `file:///` 完整路径。
  截图不复制；PNG 已经被删了的照样写这个链接；报告里没有截图时写"Couldn’t capture a screenshot: <原文>"。
- 读不出来的记录：一节 `## <序号>. <文件名> · <Unresolved/Resolved>`，写 `- Record file: <路径>` 和"Couldn’t read this record: <原文>"。

## 打开文件夹

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 工具行"Open folder" | 你点了它 | 资源管理器打开这一节的文件夹：`<userData>\feedback\` 或 `<userData>\ui-issues\`（还没有时先建好） | — |
| 打不开 | 主进程报错 | 工具行下面"Couldn’t open the folder: <原文>" | 再试 |

## 主进程多做的事（方案第 4 节"选区反馈、F8 界面问题 · Mori · 记录、收件箱、导出"，第 6 节 `feedback.ts`）

| 通道 | 做什么 |
| --- | --- |
| `mori:review-list` | 读 `feedback/` 和 `ui-issues/`，返回两类记录（读不出来的带原文） |
| `mori:review-shot` | 读一份报告的 PNG，交给界面显示（只接受 `ui-issues` 里报告时间格式的 `.png`） |
| `mori:review-export` | 弹保存对话框，按界面交来的记录名和已处理标记写导出文件 |
| `mori:review-show-export` | 在资源管理器里选中这次运行导出过的文件（"Exported …"后面的"Show in Explorer"） |
| `mori:review-show-record` | 在资源管理器里选中一份记录（详情里的"Show in Explorer"；只接受这一类文件夹里的记录文件名） |
| `mori:review-open-folder` | 在资源管理器里打开两个文件夹之一 |

后台进程不变：回到原位置用已有的 `session.read`、`session.open`。工作回顾不经过 pi，后台进程退出后也能看、能标、能导出。

## 反例

- 打开工作回顾、标已处理、导出都不改反馈和报告文件，不发任何东西给模型或后台进程。
- 导出不复制截图，也不在 `ui-issues` 之外留下别的文件（除了你选的那一个 `.md`）。
- 回复不在了时不跳到会话底部假装找到了；原会话已删除时不新建会话。
- "Hide resolved"开着时标了已处理，详情不会跟着消失（可以马上"Reopen"）。
