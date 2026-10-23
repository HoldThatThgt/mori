# 设置 → UI issues，F8 的 View in Settings，AGENTS.md 的 token 数

依据：提示词分层与记忆构建规格（[memory.md](../../specs/memory.md)，下称“规格”）§10.8（设置页的 UI issues 与 AGENTS.md）、§10.9（F8）、§10.3（token 数与超出标记）、
§10.10（后台进程退出时）、§8（动作记录）。
取代 [v0 review.md](../../v0/screens/review.md)（工作回顾，M7）的 UI issues 部分与主进程通道、[v0 f8.md](../../v0/screens/f8.md) 的 `View in Review`；
补充 [v0 settings.md](../../v0/screens/settings.md) 的 AGENTS.md 节与 [models-settings.md](models-settings.md) 的外框。工作回顾的其余部分由记忆页取代（[memory-page.md](memory-page.md)）。
界面文字为英文，按规格原文；UI issues 的文字与 M7 相同（v0 review.md）。规格没给、本表定的写作“（临时，走查时可以改）”。

## 来源

| 来源 | 内容 |
| --- | --- |
| 主进程 `mori:issues-list` | 读 `<userData>\ui-issues\`：每份报告（报告时间格式的 `.md`，同 M7 只认 Mori 写的文件）；读不出来的带原文 |
| 主进程 `mori:issues-shot` | 一份报告的 PNG（只接受 `ui-issues` 里报告时间格式的 `.png`） |
| 主进程 `mori:issues-export`、`mori:issues-show-export` | 保存对话框与导出文件；在资源管理器里选中导出的文件 |
| 主进程 `mori:issues-show-record`、`mori:issues-open-folder` | 在资源管理器里选中一份报告；打开 `ui-issues` 文件夹 |
| 本机界面状态 `localStorage` 的 `mori.review` | 已处理的标记（只用 `ui-issues/` 开头的键，原有标记照用）与 `Hide resolved` 开关 |
| F8 报告框保存的结果 | 刚存下的报告文件名（`View in Settings` 选中它） |
| `agents.get { sessionId }` 的结果 | v0 的字段，加 `loaded: { path, tokens }[] \| null`、`userTokens`、`total`（§10.3） |
| 你的操作 | 切换分节、选记录、`Resolve` / `Reopen`、`Hide resolved`、导出、打开文件夹、`View in Settings` |

`mori:review-*` 六个通道去掉反馈部分、改名为 `mori:issues-*`（§10.8）；读的仍是 `<userData>\ui-issues`，不经过后台进程。

## 外框

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 设置页的分节 | — | 左侧三节：`Models`、`AGENTS.md`、`UI issues`（`data-section="issues"`，在 `AGENTS.md` 下面） | 切换分节（AGENTS.md 有未保存的改动时先问，同 v0 settings.md） |
| 进入设置页 | 你点了侧栏 `Settings` 等 | 默认仍落在 `Models` | — |
| 从 F8 进入 | 你点了报告框的 `View in Settings` | 直接进 `UI issues` 并选中那一份（下面“F8”） | — |
| 在 `UI issues` | — | 中栏是这一节的标题 `UI issues`，带未处理的条数（为 0 时不显示数字），读屏名称 `UI issues, N unresolved`（同 M7 分节按钮的写法；标题与条数放在这里，临时，走查时可以改）；重新读取时标题旁 `Loading…`；下面是工具行与列表；选中记录时右栏打开详情（宽度与分隔线同记忆页、M7 的右栏，窗口窄于 800px 时浮在中栏上层） | 见下 |
| 在别的分节 | — | 没有右栏；回到 `UI issues` 时选中的记录、开关、滚动位置还在（同 M7，直到重启） | — |
| F8 的 Current view | 界面状态 | 在 `UI issues` 时 `Page: Settings` | — |

## 列表

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 工具行 | — | `Hide resolved` 开关；`Export as Markdown…`；`Open folder` | 见下 |
| 读取中 | 主进程在读 `ui-issues` | 第一次读在列表的位置 `Loading…`；之后重新读时上一次的列表留着、滚动位置不变，`Loading…` 在标题旁边；读完之前 `Export as Markdown…` 不可用 | — |
| 读取失败 | `mori:issues-list` 报错（文件夹不存在不算错，算空） | 原文和 `Retry` | Retry |
| 空 | 文件夹不存在或没有报告 | `No UI issues yet. Press F8 to report one.` | — |
| 都已隐藏 | `Hide resolved` 开着，报告都已处理 | `No unresolved records · N resolved records hidden`（1 条时 `1 resolved record hidden`）和链接 `Show resolved` | Show resolved（关掉 `Hide resolved`） |
| 列表 | 读到的报告 | 按报告时间从新到旧，每份一行：`What went wrong`（最多 2 行；没有填写时用 `What you expected`）、时间（`10-20 14:03`，本地时间，不是今年的带年份）、没有截图时标 `No screenshot`；没有分页 | ↑ ↓ 在行之间移动焦点；Enter 或点击打开详情；F8 记 `View record: UI issues` |
| 已处理 | 本机界面状态 | 整行变淡，标 `Resolved` | — |
| 选中 | 你选了一行 | 整行高亮，右栏是它的详情 | — |
| 读不出来的报告 | 主进程读报告出错（缺 `## What went wrong` 等标题） | 一行 `Couldn’t read the record <文件名>` 和原文；可以选中、标已处理（同 M7） | 选中 |
| 何时重新读 | 进入 `UI issues`；这一节开着时你保存了新的 F8 报告；点 `Retry` | 新报告出现在最上面；不监视文件夹 | — |

## 隐藏已处理与已处理

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 开关关着（默认） | 本机界面状态 | 全部报告；已处理的变淡并标 `Resolved` | 打开开关；F8 记 `Hide resolved` |
| 开关开着 | 你打开了开关（重启后保留） | 已处理的不列出；标题上的数字不变（一直是未处理的条数） | 关掉开关；F8 记 `Show resolved` |
| 标为已处理 | 你在详情里点了 `Resolve` | 这一行变淡并标 `Resolved`；开关开着时这一行马上不列出，右栏的详情还在，按钮变成 `Reopen`；F8 记 `Resolve` | Reopen |
| 标为未处理 | 你在详情里点了 `Reopen` | 回到平常的样子；F8 记 `Reopen` | Resolve |
| 保存 | 本机 `localStorage`（`mori.review`，按 `ui-issues/<文件名>` 记） | 重启后还在；M7 时期标过的界面问题照用；本机存储被清掉时全部回到未处理 | — |

## 详情（右栏）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 没有选中 | 刚进入这一节、关了详情 | 不显示右栏，中栏占满 | — |
| 报告 | 你选了一份报告 | 标题 `UI issues` 和 ×（读屏名称 `Close details`）；时间；`What went wrong`、`What you expected` 全文；`Screenshot` 下面是截图（按右栏宽度缩小）或 `Couldn’t capture a screenshot: <原文>`；可以展开的 `Current view`、`Recent activity`、`Versions`；`Show in Explorer`；`Resolve` 或 `Reopen` | 放大截图；展开；Show in Explorer（F8 记 `Show record in Explorer`）；Resolve / Reopen；关闭 |
| 截图读取中 / 读不出 | `mori:issues-shot` | `Loading screenshot…` / `Couldn’t load the screenshot: <原文>` | — |
| 放大截图 | 你点了截图（或焦点在截图上按 Enter） | 浮层里按原尺寸显示截图，大于窗口时缩到窗口内；`Close` | Esc、`Close` 或点截图外面关闭，焦点回到截图 |
| 读不出来的报告 | 你选了读不出来的一行 | `Couldn’t read the record <文件名>`、原文；`Show in Explorer`；`Resolve`（或 `Reopen`） | 同左 |
| 报告不在了 | 重新读取后列表里没有它了 | 关闭详情 | — |

## 导出为 Markdown 与打开文件夹

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 可以导出 | 这一节有列出的报告 | `Export as Markdown…` 可用 | Export as Markdown…；F8 记 `Export: UI issues` |
| 没有可导出的 | 一份都没列出（空，或都已隐藏） | 按钮不可用 | — |
| 选位置 | `mori:issues-export` 的保存对话框 | 标题 `Export as Markdown`；默认文件名 `ui-issues-<YYYY-MM-DD>.md`，默认放在“文档”里 | 保存；取消（什么都不变） |
| 已导出 | 主进程写完文件 | 工具行下面 `Exported N records to <路径>`（1 条时 `Exported 1 record to <路径>`）和 `Show in Explorer` | Show in Explorer（`mori:issues-show-export`） |
| 导出失败 | 主进程写文件报错 | `Couldn’t export: <原文>` | 再导出 |
| 打开文件夹 | 你点了 `Open folder` | 资源管理器打开 `<userData>\ui-issues\`（还没有时先建好）；F8 记 `Open folder: UI issues` | — |
| 打不开 | 主进程报错 | 工具行下面 `Couldn’t open the folder: <原文>` | 再试 |

导出哪些、导出的内容同 M7 的界面问题部分（v0 review.md“导出为 Markdown”：`# UI issues` 开头，每份一节，截图写相对链接、不复制）；没有反馈的导出。

## 后台进程退出时

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| UI issues | 主进程读，不经过后台进程（§10.10） | 照常可用：列表、详情、截图、`Resolve` / `Reopen`、导出、打开文件夹 | 同上 |

## F8

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 已保存 | 主进程写完报告（v0 f8.md“已保存”） | `Saved to <Markdown 文件路径>`；`Show in Explorer`；`View in Settings`（`issue-open-settings`，取代 `View in Review`；首次启动页和读取连接的页面上没有，同 M7）；`Close` | View in Settings；Show in Explorer；Close |
| View in Settings | 你点了它 | 关闭报告框，打开设置页的 `UI issues` 并选中这一份（滚到看得见的地方，同 M7）；F8 记 `View in Settings` | — |
| 有未保存的编辑 | 设置页 AGENTS.md 节或记忆页的条目表单有未保存的改动 | 先出那一处的离开确认框（同其他离开入口，临时，走查时可以改） | Discard；Keep editing |
| Current view 的 Page | 界面状态 | `Session`、`Settings`、`Customize`、`Memory`（没有 `Review`），以及原有的 `First run`、`Loading…`、`Couldn’t load model settings`；在设置页的 UI issues 时 `Settings` | — |

## AGENTS.md 节的 token 数

在 v0 settings.md 的 AGENTS.md 节上加 token 数与超出标记（proposal §5.2“超了在设置页和记忆页标出来”）；`agents-effective` 与 `.agents-path` 的文字不变。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 生效的用户级文件 | `agents.get` 的 `effectivePath`、`userTokens` | 生效文件那一行（`agents-effective`：`In effect: <路径>`，或被 `AGENTS.override.md` 盖住、生效的是 CLAUDE.md 时 v0 的警示）后面单独一个元素 `<n> tokens`（1 时 `1 token`，`agents-tokens`）；没有生效的文件时没有这一行，也没有这个元素 | — |
| 项目加载的文件 | `agents.get` 的 `loaded`（每项 `{ path, tokens }`） | 每个文件那一行，路径之外单独一个元素 `<n> tokens`（`.agents-tokens`） | Open in default app |
| 超出 | `total` > 500（`total` = `userTokens` + `loaded` 的 token 之和，没有会话时为 `userTokens`） | 警告色 `Over 500 tokens. Mori doesn’t shorten AGENTS.md; edit the files to keep prompts short.`（`agents-over`，同记忆页 `AGENT` 的文字） | 编辑文件 |
| 没有超出 | `total` ≤ 500 | 没有 `agents-over` | — |

token 用 `estimateMemoryTokens`，每个文件单独算（§10.3）；什么时候读 `agents.get` 同 v0。

## 反例

- 设置页没有反馈的列表、导出与 `Resolve`；`UI issues` 里只有 F8 的报告。
- 后台进程退出时 UI issues 照常能看、能标、能导出。
- 进入设置页仍落在 `Models`，不是 `UI issues`。
- `agents-effective`、`.agents-path` 的文字里不带 token 数。
- 报告框里没有 `View in Review`。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：这一节的标题 `UI issues`，未处理的条数放在标题上（M7 放在分节切换按钮上，设置页左侧的分节按钮不带数字）；
`View in Settings` 遇到未保存的编辑先出离开确认框。其余文字与行为照 M7（v0 review.md 的 UI issues 部分）。

## 界面测试用的标识

M7 的 `review-*` 标识改名为 `issues-*`（§10.8）；`detail-*` 不变。

| 元素 | 标识 |
| --- | --- |
| 分节 | `[data-testid="settings-nav"] button[data-section="issues"]` |
| 标题 | 未处理的条数 `issues-count`（原 `review-count`，在这一节的标题里）；重新读取时标题旁的 `issues-loading` |
| 这一节 | `issues-page`（原 `review-page`）；`review-tab-<kind>` 没有对应（只有一节） |
| 工具行 | `issues-hide-handled`、`issues-export`、`issues-open-folder`；结果 `issues-notice` |
| 列表 | `issues-list`、`issues-row`（`data-name`、`data-handled`）、`issues-row-handled`；`issues-loading`、`issues-error`、`issues-empty`、`issues-all-hidden` |
| 详情 | `issues-detail`；里面的 `detail-time`、`detail-what`、`detail-expect`、`detail-broken`、`detail-shot-loading` 等沿用 M7 |
| F8 | `issue-open-settings`（取代 `issue-open-review`） |
| AGENTS.md | `agents-tokens`、`.agents-tokens`、`agents-over`；`agents-effective`、`.agents-path`、`agents-loaded`、`agents-editor` 沿用 v0 |
| 离开确认 | `leave-dialog`（沿用 v0） |
