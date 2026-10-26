# 三栏布局（M1）

依据：方案 5.1、5.9；视觉与 `resize.js` 行为移植自 `demo/`。

## 字号与 token

- 颜色、字号、圆角、阴影、字体抽成 CSS token（`app/src/renderer/src/styles/tokens.css`）。
- 正文、输入框 13–14px；辅助文字（时间、来源、徽标、阶段行）12px；没有小于 12px 的文字。
  demo 中 8–11px 的一律上调到 12px。

## 分隔线

| 分隔线 | 范围 | 键盘 | 双击 | 保存 |
| --- | --- | --- | --- | --- |
| 左栏右边 | 180–360px，并给中栏留至少 300px（右栏开着时给右栏留它实际能用的宽度：保存的宽度最多到"窗口 − 180 − 300"，2026-10-26 走查 M23 修：原来按保存的宽度留，右栏存得宽、窗口变窄时这条分隔线消失） | 焦点在分隔线上时 ← → 每次 20px | 恢复默认：窗口宽 ≤1150 时 220px，否则 260px | 宽度存在本机（`localStorage`），重启后保留 |
| 右栏左边 | 至少 260px，不设上限，拖到中栏只剩 300px（分屏时两栏各 280px）为止（2026-10-26 走查 M23：去掉原来的 800px 上限；要让右栏占满，用顶部的"Expand"，见下面"右栏展开"） | 同上（方向相反：← 变宽） | 恢复默认：窗口宽 ≤1150 时 400px，否则 450px | 同上 |

分隔线是 `role="separator"`，可以 Tab 聚焦，`aria-valuenow` 等于当前像素宽度；拖动时整窗光标为 col-resize、不选中文字。
窗口变窄时宽度按范围收紧，变宽后不自动放大。

## 状态表

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 宽窗口（≥1024px） | 窗口宽度 | 左栏展开、中栏、右栏（打开时） | 拖动或用键盘调整两条分隔线；收起左栏 |
| 窄窗口（<1024px） | 窗口宽度 | 左栏自动收起为 60px 图标栏 | 点图标栏的展开按钮（"Open sidebar"）临时展开（浮在中栏上层） |
| 很窄（<800px，只在最小宽度以下出现） | 窗口宽度 | 右栏浮在中栏上层 | 关闭右栏 |
| 最小窗口 | 主进程 `minWidth: 800, minHeight: 600` | 800 宽时：图标栏 + 中栏 + 右栏都完整，中栏至少 300px，顶栏文字省略号截断而不溢出；输入框下面一行（权限、选择范围、Effort、上下文用量、发送）不换行、不溢出（[models.md](models.md)"窄栏"） | — |
| 左栏收起 | 你点了收起（"Close sidebar"），或窄窗口 | 图标栏："Open sidebar"、"New session (Ctrl+N)"（M3）、"Open folder…"、"Report a UI issue (F8)"（M2）、"Settings"，都是图标按钮，名称在读屏名和悬停说明里 | "Open sidebar" |
| 右栏关闭 | 本会话没有改动时默认关闭；或你关了它 | 顶栏右栏开关按钮（读屏名"Toggle changes"） | 打开 |
| 右栏打开、没有改动 | 你手动打开 | "No changes yet." | 关闭 |
| 右栏打开、有改动 | 本会话出现了编辑或写入的工具结果（pi 的 `tool_execution_end` 或会话记录里的工具结果） | 顶部注明"Only edits and writes are listed. Files changed by commands aren’t included."；按文件列出，展开后按时间顺序显示每次编辑的 diff，写入显示新内容 | 展开、收起；关闭 |
| 右栏打开、显示文件（M4） | 你点了文件路径、"Open"或文件引用芯片 | 文件阅读器，见 [changes.md](changes.md) | 返回改动；关闭 |
| 右栏展开（2026-10-26 走查 M23） | 你点了右栏顶部的"Expand"（照 Claude 的 pane 的"Expand" / "Collapse"），这个会话的右栏开着且贴在右边（不是浮在上层） | 中栏藏起（会话面板保持挂载，草稿、滚动位置、展开状态都在），右栏占满左栏右边的全部宽度，右栏的分隔线不显示；按钮变为"Collapse"。左栏照旧（收起为图标栏时右栏从图标栏右边开始）。藏起的中栏里的批准卡看不到，侧栏的会话行仍显示"Needs approval"、任务栏照常闪烁；顶栏的"Toggle changes"也够不着 | "Collapse"回到原来的宽度；"Close panel"关上右栏（同时取消展开）；点侧栏的另一个会话：那个会话没有展开（或右栏关着）时中栏照常显示 |

M4 起右栏的改动列表、文件阅读器和打开它们的入口见 [changes.md](changes.md)。
M5 起中栏可以左右分屏，右栏跟随焦点所在的一栏；分屏时放不下两栏各 280px 加最窄的右栏就先收起右栏，见 [split.md](split.md)。

"Expand" / "Collapse"（2026-10-26 走查 M23）：展开与否按会话各自记住（与右栏的开关、视图一样只在这次运行的内存里，不跨重启），只在这个会话的右栏开着、贴在右边时起作用；右栏浮在上层时（窗口窄于 800px，或分屏放不下）不显示这个按钮，回到贴在右边时恢复。分屏时展开会把两栏一起藏起。右栏窄于 320px 时顶部的"← Changes"只显示箭头（读屏名仍是"Changes"），给路径留地方。

## 左栏

M1 只列本次运行打开过的会话；M3 起换成项目 → 会话树，状态表见 [sessions.md](sessions.md)。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 顶部（M3 起） | — | "New session"主按钮（旁边"Ctrl+N"；左栏窄于 220px 时藏起"Ctrl+N"，不折行）、"Open folder…" | "New session"、"Open folder…" |
| 会话树（M3 起） | pi 的会话列表加本次打开的会话 | 见 [sessions.md](sessions.md) | 见 sessions.md |
| 设置页打开 | 你点了"Settings"或"Go to settings"（v1：见 docs/specs/model-providers.md §9.3："Go to settings"删除，改为说明卡与拒绝启动卡的"Open settings"） | "Settings"高亮 | 返回会话（"Back to app"） |
| 底部（M2 起） | — | "Report a UI issue (F8)"和"Settings"；收起为图标栏时是两个图标按钮 | 报告界面问题（见 [f8.md](f8.md)）、设置 |

Customize 页（工具页，M6）的入口"Customize"在"Open folder…"下面，见 [tools.md](tools.md)；
工作回顾（Review，M7）的入口"Review"在"Customize"下面，见 [review.md](review.md)
（v1：见 docs/specs/memory.md §10.1：同一位置换成"Memory"，打开记忆页；后台进程退出时不可用，悬停"Mori’s background process crashed. Restart it to continue."）。

## 设置页外框

- 中栏换成设置页，顶部"Back to app"；M6 起左边是分节列表（"Connections and models"、"AGENTS.md"），见 [settings.md](settings.md)
  （v1：见 docs/specs/model-providers.md §9.1："Connections and models"分节改为"Models"，状态表见 [../../v1/screens/models-settings.md](../../v1/screens/models-settings.md)）。
  Customize 页（工具页，M6）外框相同，见 [tools.md](tools.md)；工作回顾（Review，M7）顶部相同，详情放在右栏，见 [review.md](review.md)
  （v1：见 docs/specs/memory.md §10.1、§10.8：由记忆页（Memory）取代，顶部与右栏相同；设置页左边在"AGENTS.md"下面加第三节"UI issues"，在这一节时右栏可以打开）。
- 会话面板保持挂载、只隐藏，所以返回后滚动位置、草稿、展开状态都在。
