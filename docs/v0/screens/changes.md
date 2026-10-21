# 右栏：改动与文件阅读器（M4）

依据：方案 5.9、5.5（工具卡里的文件路径）、5.1（返回会话时恢复右栏打开的文件）、第 4 节"编辑后的 diff"。
右栏的外框、宽度与窄窗口见 [layout.md](layout.md)；选区、引用与反馈见 [selection.md](selection.md)。

## 开工前查的事实（pi 1.3.0 源码与本机）

| 事实 | 影响 |
| --- | --- |
| edit 工具的结果带 `details.patch`（unified diff）；write 的结果不带 diff，写入的内容只在调用参数 `content` 里 | 编辑显示 diff，写入显示新内容（M1 已有） |
| edit / write / read 按 pi 的 `resolveToCwd`（`utils/paths.js`）解析路径：去掉开头的 `@`、展开 `~`、把 Git Bash 的 `/c/...` 换成 `C:\...`、`file://` 换成路径，再相对会话的工作目录 | 阅读器按同样的规则找文件（主进程照搬这几条，见下"由谁读文件"），点开的就是 pi 改的那个文件 |
| 命令（bash / powershell）改的文件 pi 不报告 | 改动列表只含编辑和写入，顶部注明 |
| 界面进程是沙箱，不能读文件 | 文件由主进程读，只读：打开文件夹对话框、删除会话文件之外，主进程多两件事：读一个文件给阅读器、用系统默认程序打开它 |

## 右栏的两个视图

右栏一次显示一个视图，按会话各自记住（切换会话、去设置页再回来都还在；不跨重启）。M5 起分屏时跟随焦点所在的一栏，见 [split.md](split.md)。

| 视图 | 顶部 | 内容 |
| --- | --- | --- |
| 改动 | "This session’s changes"、关闭（×，读屏名"Close panel"） | 改动列表 |
| 文件 | "← Changes"（回到改动列表）、文件路径（工作目录之内显示相对路径，省略号截断，悬停显示完整路径）、"Reload file"、"Open in default app"、关闭（×，"Close panel"） | 文件阅读器 |

照 Claude 桌面版：点工具调用里的文件路径，右侧打开这个文件的只读预览，带"Open in {editor}"；预览和改动列表在同一个右栏里切换，× 关闭右栏。

## 改动列表

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 没有改动、右栏关闭 | 本会话没有完成的编辑或写入 | 顶栏的右栏开关 | 打开右栏 |
| 没有改动、手动打开 | 你打开了右栏 | "No changes yet." | 关闭 |
| 有改动 | 编辑或写入的工具结果：pi 的 `tool_execution_end`（`isError` 为假），或会话记录里成功的工具结果 | 顶部注明"Only edits and writes are listed. Files changed by commands aren’t included."；每个文件一行：路径、"N changes"（1 次时"1 change"）、"Open"按钮；按文件第一次改动的先后排列 | 展开 / 收起一个文件（Enter、空格）；"Open"打开阅读器 |
| 展开的文件 | 同上 | 按时间顺序列出这个文件的每次改动，每次标"Change N · Edit"或"Change N · Write" | — |
| 一次编辑 | edit 结果的 `details.patch` | diff（上下合并，长行折行） | — |
| 编辑没有 diff | edit 成功了但结果里没有 patch | "This edit didn’t return a diff." | 打开文件看现在的内容 |
| 一次写入 | write 调用参数里的 `content` | "Change N · Write"、"File content"和内容原文 | — |
| 有改动时自动打开 | 本会话第一次出现编辑或写入结果 | 右栏自动打开到改动列表；你手动开关过之后以你为准（M1 起，临时默认值） | — |
| 失败、被拒绝、已停止、已中断的编辑或写入 | 文件没有被它改动 | 不列出 | — |

照 Claude 桌面版：改动是右栏里按文件折叠的 diff 列表，文件行上有打开文件的按钮。

## 文件阅读器

由谁读文件：主进程（`mori:read-file`）按上面的规则解析路径，只读，不监视文件（不占后台 CPU）；
阅读器打开时，本会话对同一个文件的编辑或写入完成后自动重新读一次，其他情况（命令改的、外部改的）点"Reload file"。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 读取中 | 你点了文件路径、"Open"、"Reload file"或引用芯片 | "Loading…" | 返回改动（"← Changes"）、关闭 |
| 显示 | 文件存在、是文本（前 8KB 没有 0 字节）、不超过 1MB | 行号和内容，只读；按扩展名语法高亮（超过 200KB 的不高亮，临时默认值）；长行不折行，横向滚动 | 用鼠标选中文字（浮层见 selection.md）；滚动；"Reload file"；"Open in default app"；返回改动；关闭 |
| 跳到引用 | 你点了一个文件引用芯片（selection.md） | 滚到引用的行，这几行高亮，直到下一次跳转或重新读取 | 同上 |
| 原文已变化 | 引用的原文在文件里找不到了（selection.md） | 顶部提示"Source changed · Attached text:"和原文；滚到原来的行 | 同上 |
| 文件已被删除或移动 | 路径不存在 | "File not found"和完整路径 | "Reload file"；返回改动；关闭 |
| 无法预览：二进制 | 前 8KB 里有 0 字节 | "Preview unavailable · Binary file" | "Open in default app" |
| 无法预览：太大 | 文件超过 1MB（方案 5.9） | "Preview unavailable · File is larger than 1 MB (X MB)" | "Open in default app" |
| 无法预览：文件夹 | 路径是文件夹 | "Preview unavailable · This is a folder" | "Open in default app"（在资源管理器里打开） |
| 读取失败 | 其他错误（例如没有权限） | "Couldn’t read this file: "加原文 | "Reload file" |
| 系统编辑器打开失败 | `shell.openPath` 返回的错误 | 顶部下方一行"Couldn’t open this file with the default app: "加原文 | 再试 |
| 会被运行的文件 | 扩展名在 `PATHEXT` 里，或是常见的脚本、快捷方式、安装包（.bat、.ps1、.py、.lnk、.msi 等） | 不打开（Windows 会运行它），改为在资源管理器里选中它，顶部下方一行"Opening this kind of file would run it, so it’s selected in File Explorer instead. Open it in an editor." | — |
| 网络路径 | 解析出的路径是 `\\主机\共享\…` | 不读也不打开（访问它会让 Windows 向那台主机认证）："Couldn’t read this file: "加原文 | — |

## 打开阅读器的入口

| 入口 | 范围 | 键盘 |
| --- | --- | --- |
| 工具卡标题里的路径 | 读取、修改、写入三种工具（参数里有 `path`）；列目录、搜索、查找不算 | 路径是标题里的按钮，Tab 到它按 Enter；点路径不展开工具卡 |
| 改动列表每个文件行的"Open" | 列表里的全部文件 | Tab、Enter |
| 文件引用芯片 | 输入框里和发出的消息里的文件引用 | Tab、Enter |

改动列表按文件分组、阅读器判断"本会话改了这个文件"时，按 pi 的规则比较路径：`./a.ts`、`@a.ts`、Git Bash 的 `/c/...`、
绝对路径指同一个文件时算同一个（`~` 开头的不展开，界面拿不到用户目录）。

## 反例

- 命令改的文件不出现在改动列表里。
- 被拒绝或失败的编辑不出现在改动列表里。
- 阅读器里不能改文件，也没有保存按钮。
- 删掉的文件不显示上次读到的旧内容；换一个文件打开时不先显示上一个文件。
- 点"Open in default app"不会运行模型写的脚本或程序。
