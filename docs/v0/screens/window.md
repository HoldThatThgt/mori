# 窗口、系统托盘与退出（2026-10-26 走查，WP-20）

依据：负责人 2026-10-26 走查第 M27 条（"when close window, mori exits instead of minimizing to hidden icons panel"），
照 Claude 桌面版（Windows）：关掉窗口时 Mori 留在系统托盘里，会话照常运行；从托盘菜单退出。
取代 M0 的"命令运行中关闭窗口：程序 10 秒内自行退出"（[../m0-checks.md](../m0-checks.md) 第 13 项）：有序关闭后台进程不变，
只是从"关掉窗口"挪到"真正退出"。检查记录见 [../../v1/walkthrough-1026/WP-20.md](../../v1/walkthrough-1026/WP-20.md)。

Claude 的原文取自它的主进程字符串表（`resources/en-US.json`）；托盘菜单的项、左键的行为、退出前的确认框按钮
取自它主进程代码里的写法（`app.asar` 的 `.vite/build/index.chunk-*.js`：托盘菜单只有 "Show App"、分隔线、"Exit"，
登录后中间多两行用量；左键显示并聚焦主窗口；确认框是 Windows 的警告对话框）。

## 来源

主进程的系统事件：主窗口的 `close`、托盘图标的 `click` 与托盘菜单的两项、应用菜单的 File → Exit、第二次启动（单实例锁的 `second-instance`）、
退出（`before-quit`、`will-quit`）；界面报告的正在生成的会话数（`mori:busy-sessions`，见下面"正在生成的会话"）；
批准卡请求的提醒（`mori:attention`，[approval.md](approval.md)"任务栏闪烁"）；标记文件 `<userData>\tray-notice-shown`
（第一次关窗口的提示已经显示过）。

## 状态

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 运行中 | Mori 启动、拿到这个数据目录的单实例锁 | 系统托盘里有 Mori 的图标（临时图标，见 [../defaults.md](../defaults.md)"托盘图标"），悬停说明"Mori"；窗口照常打开，菜单栏是"File"（只有"Exit"）、"Edit"、"View"、"Window"（后三个同 Electron 默认菜单；2026-10-26 审查修正起不再有 Electron 默认的"Help"，见 [../defaults.md](../defaults.md)"应用菜单"） | 左键点图标；右键打开托盘菜单；File → Exit |
| 关掉窗口 | 你点窗口的 ×、按 Alt+F4 或 Ctrl+W（菜单栏 Window → Close），或任务栏按钮右键的"Close window"（主窗口的 `close`，不是退出时的那一次） | 窗口藏起，任务栏上没有 Mori 的按钮；托盘图标还在；所有会话照常运行：生成中的回复、运行中的命令、等你批准或回答的卡、后台的 Agent、增强任务都不停，后台进程不关；界面状态（草稿、分屏、开着的页面、没保存的 AGENTS.md）原样留着；不弹任何确认 | 点托盘图标或"Show App"；再次启动 Mori；"Exit" |
| 第一次关掉窗口 | 同上，标记文件还不存在 | 托盘气泡（`Tray.displayBalloon`，info 图标；Windows 10/11 上显示为 Mori 的系统通知）：标题"Mori runs in the system tray"，正文"Mori runs in the background even when you close the window. Click the Mori icon in the system tray to reopen the app, or right-click to quit."；之后写下标记文件，以后再关窗口（包括重启 Mori 之后）不再提示 | — |
| 打开窗口 | 左键点托盘图标；托盘菜单"Show App"；再次启动 Mori（第二个进程把这件事交给已在运行的 Mori，自己马上退出，退出码 0） | 窗口回到原来的位置和大小，在最前面并拿到焦点；最小化着的先还原；已经在前台的只是拿到焦点；界面状态和关掉前一样（期间发生的事件照常进了界面） | — |
| 托盘菜单 | 右键点托盘图标 | "Show App"、分隔线、"Exit" | Show App；Exit；Esc 或点别处关上菜单 |
| 退出，没有会话正在生成 | 托盘菜单"Exit"或应用菜单 File → Exit（同 Claude：两处是同一个退出），界面报告的数是 0 | 窗口和托盘图标马上消失；有序关闭后台进程（与原来关窗口时一样：最多等 3 秒释放会话，再结束后台进程和它启动的所有进程），之后进程结束 | — |
| 退出，有会话正在生成 | 托盘菜单"Exit"或应用菜单 File → Exit，界面报告的数 N 大于 0 | Windows 警告对话框，标题"Mori is still working"，说明"Mori is working in 1 session. Quitting now will interrupt that work."（N 大于 1 时"… in N sessions. …"），按钮"Quit anyway"和"Cancel"，Enter 与 Esc 都是"Cancel"；窗口开着时对话框挂在窗口上，窗口藏着时单独弹出 | Quit anyway（同上一行退出，正在生成的回复和命令被中断，同原来关窗口）；Cancel（什么都不变，会话照常运行） |
| 确认框开着时又点"Exit" | 同上 | 不弹第二个确认框 | — |
| 窗口藏着时出现批准卡 | `mori.approval_request`（协作模式的 `mori.team_approval_request` 同样），窗口藏在托盘里 | 窗口以最小化的样子回到任务栏（不抢焦点、不弹到前面），任务栏按钮闪烁；见 [approval.md](approval.md)"任务栏闪烁" | 点任务栏按钮或托盘图标回到 Mori（停止闪烁） |
| 窗口藏着时后台进程意外退出 | 主进程收到后台进程 `exit`（非有意关闭） | 托盘图标照旧；打开窗口后看到 [chat.md](chat.md)"后台进程退出"的横幅和"Restart" | 打开窗口；Exit（数已是 0，不问；没有要关的后台进程，进程马上结束——2026-10-26 集成时修正：原来这时 Mori 没有窗口、没有托盘图标却一直不退出，还占着单实例锁） |

其他退出的方式不经过这两个"Exit"，也不问：
- 测试用 Playwright 的 `app.close()`（直接 `app.quit()`）结束 Mori：照样有序关闭后台进程，只是不先确认，所以界面测试的收尾
  不会卡在确认框上（确认放在两个"Exit"的点击里，不放在 `before-quit` 里）。
- Windows 注销、关机或重启：Electron 在 Windows 上这时不发 `before-quit`、`will-quit`（见 Electron 对这两个事件的说明），
  所以**没有**有序关闭后台进程：系统直接结束 Mori，后台进程和它启动的命令随作业对象一起结束（M1 起的作业对象，
  "最后一个句柄关闭时结束全部进程"），正在生成的回复被中断。没有实测（2026-10-26 审查修正）。

同一个数据目录同时只跑一个 Mori（Electron 的单实例锁按数据目录）：测试用 `MORI_USER_DATA` 指向别的目录时是另一个 Mori，
各自有托盘图标；开发构建不设 `MORI_USER_DATA` 时用的是 `%APPDATA%\Mori`，与安装版是同一个数据目录，安装版开着时它只会把安装版的窗口叫出来。

## 正在生成的会话

界面每次状态变化时数一遍正在生成的会话，数变了才经 `mori:busy-sessions` 告诉主进程（页面加载、重新加载后先报一次）。
算法与侧栏会话行的状态相同（`sessionRows.ts` 的 `isBusy`，[sessions.md](sessions.md)"状态"）：状态是"Running"、"Needs approval"、
"Needs input"的会话，包括本次打开过的（看对话流，协作模式下后台 Agent 在跑或排队、有待判断的消息也算）和界面重新加载后还没点开、
仍在后台进程里运行的（看 `session.list` 带回的 `live`）。后台进程意外退出后这些状态都消失，数变成 0。
主进程只记最后一次的数，不自己判断；只接受 Mori 自己的页面发来的、不小于 0 的整数，其余记错误日志后丢掉。

**不算**记忆的增强任务（[../../specs/memory.md](../../specs/memory.md) §9.6 的看不见的会话和它的 TaskBoard）：它们不在侧栏里。
增强正在运行时点"Exit"不问，直接退出；这次运行在下次启动时记为失败（"Mori closed during the run"），再按 memory.md §9.10、
§9.3 排队重跑，已经写入的改动留在条目里、可以用那条修订回滚。Claude 数的是有后台任务的会话；要不要把增强也算进来见
[../defaults.md](../defaults.md)"正在生成的会话"一行。关掉窗口不再中断增强（原来关窗口即退出）。

## 反例

- 关掉窗口不结束任何会话、命令或后台进程，不弹确认，也不丢草稿。
- 再次启动 Mori 不开第二个窗口、不起第二个后台进程。
- 第一次之后再关窗口不再弹气泡，重启 Mori 之后也不弹。
- 窗口藏着时出现批准卡，窗口不弹到前面抢焦点。

## 界面测试怎样碰到托盘

托盘和它的菜单没有界面元素，Playwright 点不到。测试在主进程里（`app.evaluate`）用 Node 的 `inspector` 会话按原型
（`Tray.prototype`、`Menu.prototype`）找出 Mori 建的托盘和托盘菜单（`Runtime.queryObjects`；找到的对象里有不是真正实例的，
原生方法对它们报"Illegal invocation"，跳过），再发出托盘的 `click`、
调用菜单项的 `click()`；气泡和确认框分别把 `Tray.prototype.displayBalloon`、`dialog.showMessageBox` 换成记录调用的版本
（确认框按测试给的按钮回答）；应用菜单经 `Menu.getApplicationMenu()` 读出，File → Exit 同样调用菜单项的 `click()`。
这些都只在测试进程里做，`src/` 里没有给测试用的入口（`tests/ui/tray-helpers.mjs`）。
悬停说明和交给托盘的右键菜单没有读取接口：`m0-smoke` 启动开发构建时用 `-r` 在 Mori 的主脚本之前载入 `tests/ui/tray-hook.cjs`，
它记下 `Tray.prototype.setToolTip`、`setContextMenu` 的参数（2026-10-26 补；打包程序不认 `-r`，这两项只在开发构建上查）。
