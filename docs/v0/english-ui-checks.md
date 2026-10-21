# 英文界面检查记录（显示语言改为英文）

日期：2026-10-21。机器：Windows 11（10.0.28000），Node 24.19.0；Electron 44.9.0；pi 1.3.0；electron-builder 26.17.0。
分支 `english-ui`（基于 `app-v0` 的 `12f2326`，即 M7 合并之后），三个提交：`948f935`（`app/src` 的全部中文字串
（103 个文件），以及 `tests/check.mjs` 的中文检查、`electron-builder.yml` 的 `installerLanguages`、`build-installer.cmd`
只输出英文、新的 [ui-strings.md](ui-strings.md)）、`44bc45b`（测试、回放桥和文档）、`f381eed`（从真实会话重录含 Mori 文字的
fixture，修两个过时的脚本）。
还没有提交的修正：`app/tests/ui/m5-app.mjs`（测试的时机问题）、仓库根目录的 `build-installer.cmd`（控制台是 936 代码页时的问题），
以及审查后的第二轮：`app/src` 三个文件（表单不用浏览器自带的校验、Chromium 固定用英文、选文件夹对话框的英文标题）和
`m1-app.mjs`、`m6-app-settings.mjs` 新加的 3 项检查，见"测试中发现并已修正的问题"第 7–8 条；这份记录、`docs/v0/english-ui/`
的截图、`app/README.md`、`docs/app-v0.md` 和 `ui-strings.md` 的改动也没有提交。分支没有推送，也没有合并进 `app-v0`。
上面这些后来都提交在 `7500596`（各条里的"没有提交"是写下时的状态）。之后的第三轮修了会话引用预览的标题被压矮，
审查后又收紧了新加的检查（见"第三轮"），改了 `app/src/renderer/src/styles/split.css`、`app/tests/ui/` 的
`m5-helpers.mjs`、`m5-app.mjs`、`m5-replay.mjs`、`m5-real.mjs`，状态表 [screens/session-refs.md](screens/session-refs.md)、
这份记录和 `english-ui/m5-preview.png`，都没有提交。

## 状态

按 AGENTS.md 的完成顺序，只差你走查。这次只换文字、不加界面，实际的顺序是：先定术语表
[ui-strings.md](ui-strings.md)（代替状态表；各屏状态表里引用的界面文字跟着改成英文）→ 改 `app/src` → 改测试和文档 →
用真实会话重录含 Mori 文字的 fixture → 合成端点的整机测试、界面回放、DeepSeek 走查（开发构建和打包程序各一遍）→
一键导出安装包（M7 走查 5 用英文的代码再做一遍）→ 你走查。fixture 排在实现之后，见"与方案不同"第 1 条。
M2–M7 的走查也还没签收（[m7-checks.md](m7-checks.md)"状态"）。这次没有改行为，那些走查要看的东西不变，
只是界面上的字换成了英文；另外顶栏、侧栏、设置页按英文字宽重新定了几处宽度（"与方案不同"第 3 条）。
真实端点仍是 DeepSeek 公网端点（`deepseek-flash`），key 用你在 Mori 里加密保存的那一份（`%TEMP%\mori-real-data`）；
脚本不读取 key：走查和录制用 `tests/ui/lib.mjs` 的 `scratchUserData` 把这个文件夹里的 `credentials.json`（加密的 key）、
`Local State`（解密要用）、`pi/models.json` 和 `pi/settings.json` 复制到临时数据目录再用（`m1-real`、`m1-record` 的几项反例
不复制前两个）；`m0-real` 用的是同样复制出来的临时副本，跑完已删除。重录的 fixture 里没有 key，也没有这个文件夹的路径（已扫描）。

结果一览：合成端点的整机测试 840 项（另有 1 项 KNOWN，pi #9129）在开发构建和打包程序上全部通过；界面回放 367 项
在开发构建上全部通过；M0–M7 的 DeepSeek 走查 274 项（另有 1 项标为模型行为的 KNOWN）在开发构建和打包程序上都通过，
其中几项要重跑才过（模型行为、时机，见"结果"）；一键导出安装包在 `f381eed` 的干净克隆里跑通，打出的安装包只带英文的
安装和卸载界面（静态检查）；控制台是 936 代码页时脚本会把中文注释的半句当命令执行，已修正（没有提交）。
审查后第二轮改了 `app/src`（表单不用浏览器按系统语言弹的校验气泡、Chromium 固定用英文、选文件夹对话框的英文标题），
之后在开发构建和打包程序上重跑了全部整机测试（843 项，比第一轮多 3 项新检查）、在开发构建上重跑了全部界面回放，都通过
（几项要重跑：锁屏时剪贴板不能用、`m4-replay` 已知的拖选时机，见"第二轮"）；真实端点的走查和一键导出安装包没有在第二轮重跑。
第三轮修了会话引用预览的标题被压矮（原来就有）：`.ref-preview h2` 加 `flex: none`。新加的 5 项检查里 `m5-app` 的 3 项、
`m5-replay` 的 1 项在改之前的构建上失败（`m5-real` 那一项没有在改之前跑）。审查后收紧了检查（长名字那一项要求标题横向
裁掉放不下的部分、对话框没有被撑宽，`m5-real` 那一项要求轮次列表占满对话框）：把标题错改成 `overflow: visible` 时长名字
那一项失败；收紧后 `m5-app` 39 项（开发构建和打包程序）、`m5-replay` 21 项（开发构建）、`m5-real` 17 项（DeepSeek，
开发构建）全部通过；`m5-real` 在打包程序上只跑过收紧之前的版本（也是 17 项全部通过），见"第三轮"。
到现在为止只有测试脚本和几张截图"看过"英文界面，还没有人从头到尾用眼睛看过（见"未验证"）。

## 你决定的

都是 2026-10-21 定的：前五条在当天一早（开工时你先答了四个问题，接着在对话里要求用 Claude 的词），"Attach as context"
和 Customize 在术语表草稿之后，最后两条是之后看了英文界面提的两件事。

| 问题 | 你的回答 | 现在的做法 |
| --- | --- | --- |
| 英文用词照什么 | 我们的界面大部分在 Claude 桌面版里有对应，用和 Claude 一样的说法（"我最常用 Claude，想保持同样的说法"） | ui-strings.md "写法约定"第一条：有对应（同一类控件或同一类提示、意思真的一样）时用 Claude 英文界面的原词；没有对应时按约定自己写。词从哪里来见下"照 Claude 桌面版" |
| 以前存下的中文记录要不要兼容 | 不兼容（AGENTS.md 不加兼容层） | 以前存的中文 F8 报告在工作回顾里是读不出来的记录（"Couldn’t read the record <文件名>"，带原文）；旧消息里的中文引用块不再拆成芯片，按全文显示 |
| 轮 | turn | "Turn 3"、句中小写 "turns 3–4"；给模型的会话引用每轮以 `Turn N` 开头 |
| 插话 | Steer（你在 Steer 和 Interject 之间选了 Steer） | 按钮、排队区标签、按键提示 "Ctrl+Enter to steer"、操作记录 "Steer: …"；排队用 Claude 的 Queue / Queued |
| 工作回顾 | Review | 左栏导航、页标题、"View in Review"、F8 报告的 "Page: Review" |
| 引用这一族（选区的"问 Mori"、会话菜单的"引用到当前会话"、回复下的"引用到输入框"、把会话拖进输入框） | 用 Claude 的 "Attach as context" | 选区浮层和会话菜单 "Attach as context"，回复下 "Attach message as context"，拖放提示 "Drop to attach as context"；芯片和预览 "Context · …"、"Remove context"、"Not attached"、"the attached text"；发给模型的文字不变，仍是 "Quoting …:" 和 "[Quote] …"；工作回顾里反馈的 "Quoted text" 是反馈针对的原文，不属于这个功能，没有改 |
| 工具页 | Customize（Claude 开关技能、插件、连接器的页面叫这个） | 左栏导航、页标题、F8 的 "Page: Customize"、操作记录 "Open Customize"；分节标题 Built-in tools / Skills / Plugins / MCP 不变；代码里的文件名（`ToolsPage.tsx` 等）和状态表 [screens/tools.md](screens/tools.md) 没有改名 |
| 会话引用预览的标题被压矮、字的下面被裁掉（原来就有；先前记成"顶部被切掉一点"，量过之后是下面：回放里一行 20px 只剩 16px 看得见，超过 2 万字的会话整行看不见） | 在这个会话里修 | 第三轮已修（没有提交）：`split.css` 的 `.ref-preview h2` 加 `flex: none`；`m5-app` 加 3 项、`m5-replay` 加 1 项、`m5-real` 加 1 项检查，审查后收紧过；`m5-app`、`m5-replay` 的新检查在改之前的构建上失败、改后通过（见"第三轮"、"测试中发现并已修正的问题"第 9 条） |
| 分屏一栏约 460px 时会话名被挤到约 2 个字符 | 把模型、Effort、权限按钮从顶栏移到输入框下面一行（像 Claude 桌面版），不选"权限按钮只留图标"；Effort 仍是单独的按钮（不像 Claude 那样放进模型菜单）；上下文用量改成模型按钮旁边的小圆环（像 Claude） | 不在这个分支做：英文界面提交之后，在从 `english-ui` 分出的 `composer-pickers` 分支上做（分支还没有建）；这个分支里顶栏的布局不变（见"与方案不同"第 3 条） |

"新会话"叫 "New session" 是任务说明里给定的（术语表里标"负责人定"）。排队叫 "Queue" / "Queued" 不是你定的：它只出现在
"插话"那个问题里 Interject 选项的说明中，你选的是 Steer，Queue 是这个会话自己照 Claude 的词定的（见下"需要你确认的地方"）。
其余的词是照"有对应就用 Claude 的词"这条规则定的，不是你逐条定的，例如：Effort 的档位（Off / Low / Medium / High /
Extra high / Max，minimal 没有 Claude 对应，用 pi 的名字）、"Allow once"、"Allow “<工具>” for this session"、"Deny"、权限模式 "Ask each time" / "Allow all"
（不用 Claude Code 的 "Bypass permissions"）、"Archive" / "Unarchive"、侧栏的 "Needs approval" 与对话里的
"Waiting for your approval"、设置等三页的 "Back to app"、信任询问的 "Trust workspace"、"Show in Explorer"、后台进程意外退出
一律写 "crashed"、工作回顾的 "Resolve" / "Reopen"。完整的列表在 ui-strings.md 的术语表（"Claude 桌面版的用词"一列）。

## 照 Claude 桌面版

Claude 的原词取自本机装的 Claude 桌面版自带的三张英文字串表（Microsoft Store 包 `Claude_2.7032.0.0`）：
`app\resources\ion-dist\i18n\en-US.json`（30,812 条，大部分词从这里来）、`app\resources\ion-dist\i18n\dynamic\en-US.json`
（47 条，模型菜单里 Effort 的档位 Off / Low / Medium / High / Max）、桌面外壳的 `app\resources\en-US.json`（739 条，例如
"Name"、"No response"）。
只按 Mori 的某个控件或提示去查它对应的词，用到的都是按钮名、
标签和短句，没有成段搬用。实现时每一处中文字串（948 行）都在一张对照表 `translations.json`（864 条）里记了文件、行、
种类（界面 / 读屏名 / 操作记录 / 给模型的文字）、是否被别处解析、Claude 的键和原文，并用脚本核对过 Claude 的原文与
字串表一字不差；这张表没有放进仓库（见"与方案不同"第 7 条）。

和照字面翻译不同、照 Claude 改过来的几处（全部见 ui-strings.md）：

| 中文 | 照字面 | 现在（Claude 的词；另有标注的除外） |
| --- | --- | --- |
| 回复（助手的） | reply | response（"Stop response"）；只有给模型读的文字里写 reply（"Quoting your earlier reply:"） |
| 后台进程退出 | stopped / exited | crashed（Claude："Claude Code crashed"）；"Stopped" 只留给停止按钮的结果 |
| 返回会话 | Back to session | Back to app |
| 打开所在文件夹 / 用系统编辑器打开 | Open containing folder / Open in editor | Show in Explorer / Open in default app（后者不是 Claude 的原句，是用 Claude 的 "Open in {editor}" 和 "Default app" 两条拼出来的） |
| 已处理 / 未处理 | Done / Not done | Resolved，动作 Resolve / Reopen（Claude 评论用的词）；Unresolved 是 Mori 自己写的（Claude 没有这个词，是 "Resolved" 的反义） |
| 还有 N 张（批准卡）、还有 N 个（问题） | N more requests / questions | {n} more |
| 信任这个文件夹 | Trust this folder | Trust this workspace?、Trust workspace |

没有 Claude 对应、按 ui-strings.md 的约定自己写的：Steer、"Report a UI issue" / "UI issues"（Claude 的 "Report a bug"
是发给 Anthropic 的，不是一回事）、"Source changed"、"Mori’s background process"、MCP 的 "direct calls"、Effort 的 Minimal。

## 需要你确认的地方（都已按推荐做法实现，走查时可以改）

下面这些是这个会话自己定的，没有问过你（术语表草稿里列为待定，之后由会话按推荐做了；以前这份记录把它们写成"你决定的"，
是错的）。每一条都只改文字，要换成另一种说法时改 [ui-strings.md](ui-strings.md) 和对应的代码、测试即可。

| 地方 | 现在 | 另一种做法 |
| --- | --- | --- |
| 思考强度 | Effort（Claude 模型菜单里的词；按钮 "Effort: High"） | "Thinking" / "Thinking level"（pi 的叫法） |
| 输入框的读屏名 | "Message Mori" | Claude 式的 "Reply to Mori" |
| 阶段行"生成中" | "Responding…" | Claude 的 "Writing…" |
| 信任 / 打开 | 讲信任时叫 workspace（"Trust this workspace?"、"Trust workspace"，Claude 的说法），打开时仍叫 folder（"Open folder…"） | 一律叫 folder（"Trust this folder?"） |
| 读一行的工具卡 | 仍写 "lines 5–5"（`toolTitle.ts`，没有改代码） | 单行时写 "line 5" |
| MCP 表单在表单和 JSON 之间切换失败 | 问题仍显示在 "Couldn’t save:" 后面（`ToolsMcpForm.tsx`，没有改代码） | 单独的说法，例如 "Couldn’t switch to JSON: …" |
| 排队发送 | Queue（按钮、操作记录）/ Queued（排队区标签），按键提示 "Enter to queue"（Claude 的词） | 别的说法，例如 "Send later" / "Pending" |
| 选文件夹对话框（这次审查后加的） | 标题 "Select a folder"（Claude 有这条）、按钮 "Select folder"；"Open folder…" 和 Customize 的 "Add plugin from folder…" 共用一个对话框 | 按用途分开写（例如 "Open folder" / "Add plugin from folder"），要给 `pickFolder` 加参数 |

## 开工前查的事实

| 问题 | 查到的 |
| --- | --- |
| Claude 的英文字串在哪 | 本机 Microsoft Store 包 `Claude_2.7032.0.0` 里的三张表（见上"照 Claude 桌面版"），共约 31,600 条 |
| 哪些已提交的 fixture 里有 Mori 写出的中文 | 按旧的格式（"引用…："、"第 N 轮"、"用户："、"助手："、F8 报告的字段）找：M4 的 4 个 `quote-*`、M5 的 4 个 `ref-*`、M7 的 `review-reply`；其余 fixture 里的中文是测试的提示词、会话名和模型的回答（见下"fixture"） |
| 以前存下的中文记录 | F8 报告按中文的节标题切（"哪里不对"等），消息里的引用块按中文开头认；改成英文后不认旧的（你定的不兼容） |
| 安装包的语言 | electron-builder 26.17 不写 `installerLanguages` 时 NSIS 安装包带 26 种语言、按系统语言选（中文 Windows 上是中文） |
| `build-installer.cmd` | M7 时失败的提示是英文和中文各一行（切到 65001 用 `findstr` 取出文件末尾的中文） |

## 交付了什么

| 范围 | 实现 |
| --- | --- |
| 界面（renderer） | 全部组件和状态模块里的界面文字、读屏名、悬停提示、确认框改成英文（`948f935`，`app/src` 下 103 个文件）；`src/renderer/index.html` 的 `lang="zh-CN"` 改成 `lang="en"`（读屏按它选语音）；数量插进句子时有单复数（导出条数、隐藏条数、改动次数、字数、MCP 服务的会话数、已完成的轮数、模型数、剩余秒数）；开关的读屏名和操作记录用单数分类名（`KIND_ONE`，放在 `shared/protocol.ts` 的 `RESOURCE_KINDS` 旁边） |
| 主进程 | 对话框；F8 报告的 Markdown（`main/feedback.ts`：`# UI issue · <时间>`、六节 What went wrong … Versions、`![Screenshot](…)`、`(left blank)`）；工作回顾的读法和导出（`main/review.ts`：标题正则 `/^# UI issue · (.+)$/`、`ISSUE_SECTIONS`、截图失败行 `/^Couldn’t capture a screenshot:\s*/`；保存对话框标题 "Export as Markdown"，默认文件名 `feedback-<日期>.md`、`ui-issues-<日期>.md`）。完整格式见 ui-strings.md "Mori 写出的文字的完整格式" |
| 后台进程、preload、shared 里显示在界面上的错误原文 | `kernel/config.ts`（"API key is required when the base URL changes"，界面上前面加 "Couldn’t save: "）、`kernel/sessions.ts` 与 `state/projects.ts`（"This session is still running. Stop it first." / "This session is still opening."）、`kernel/resources.ts`、`kernel/mcpConfig.ts`（"Mori only supports direct calls (exposure: direct)."）、preload 的 "Mori’s background process crashed (exit code N)"；注释里引用的界面文字照抄英文 |
| 发给模型的文字 | 引用块开头 "Quoting your earlier reply:"、"Quoting src/a.ts, lines 3–5:"、"Quoting session “…”, turns 3–4:"（`state/quoteText.ts`）；会话引用每轮 `Turn N`、`User:`、`Assistant:`、`[Tool] …`、`[Quote] …`（`state/sessionRefs.ts`）；工具卡标题也进 `[Tool]` 行（`toolTitle.ts`）。读的一方（`stripQuotes`）用同一组函数拼出前缀比对 |
| 宽度 | 英文比中文宽，按 Segoe UI 实测重新定了顶栏、侧栏、设置页、Customize 页、工具卡和会话菜单的宽度（阈值见"与方案不同"第 3 条） |
| Chromium 和 Windows 给的文字（审查后的第二轮，没有提交） | 主进程在 ready 之前 `app.commandLine.appendSwitch('lang', 'en-US')`：Chromium 自带的文字（表单校验气泡等）和 `navigator.language` 固定用英文，不跟 Windows 显示语言走；连接表单和模型表单加 `noValidate`，上下文长度填 0 时由 Mori 的检查给出 "Context window must be a whole number above 0."；选文件夹对话框的标题 "Select a folder"、按钮 "Select folder"。对话框其余部分（取消按钮、导航栏）和 Windows 给的错误原文仍跟 Windows 显示语言（ui-strings.md "写法约定"） |
| 安装包 | `app/electron-builder.yml` 的 `nsis:` 加 `installerLanguages: [en_US]`：不写时打包全部 26 种语言、按系统语言选，中文 Windows 上安装界面是中文 |
| `build-installer.cmd` | 只输出英文：去掉了文件末尾的中文提示和失败时切到 65001 用 `findstr` 取出它们的代码，失败时写明是第几步（如 `[3/5] npm run dist failed.`），退出码不变。仍切到 437 代码页：控制台是 936（中文 Windows 的默认）时，cmd 读这份 UTF-8 文件会把中文 REM 注释拆开、把半句当命令执行。这次走查发现只在开头 `chcp 437` 还不够，改成用新的 cmd 在 437 下重新运行自己（没有提交，见"测试中发现并已修正的问题"第 5 条） |
| 静态检查 | `tests/check.mjs` 加一项：用 TypeScript 语法树取出 `src/` 里 .ts / .tsx 的字符串、模板字符串各段、正则字面量和 JSX 文本，以及去掉注释后的 .html、.css，不能有中文（中日韩统一表意文字含扩展 A、中日韩符号和标点、半角及全角形式、假名），报 "<文件>:<行> contains Chinese text: …"；注释不查。`npm run check` 和 `npm run dist` 都会跑它 |
| 测试（`44bc45b`） | `tests/ui` 里每个整机测试、回放、录制、走查脚本和共用的辅助都改成按英文找控件、核对英文（测试的提示词、模型的回答和 record() 的中文说明不改）；回放桥 `harness/replay.js`、`harness/main.jsx`，`harness/index.html` 改成 `lang="en"`；`m4-record.mjs` 改为像 `m5-record.mjs` 那样用 esbuild 引 `quoteText.ts`，不再自己抄一份引用块的写法；新加的宽度检查：`m6-app-slash` 4 项（每两个新旧阈值之间取一个宽度，旧的 CSS 下都会失败）、`m3-app` 1 项（侧栏拖到 180px）、`m6-app-settings` 1 项（800px 宽窗口时连接表单的标签在输入框上面）；`m7-helpers.mjs` 的导出开头检查单复数（"1 records" 算错） |
| 文档（`44bc45b`） | 引用的界面文字和 Mori 写出的固定格式改成英文，正文仍是中文：`AGENTS.md`（界面文字用英文、注释仍用中文；`npm run check` 的说明）、`app/README.md`、`docs/app-v0.md`（第 2 节、第 11 节等）、[defaults.md](defaults.md)、[m6-mcp-shared.md](m6-mcp-shared.md)、`screens/` 下的 README、approval、changes、chat、connection、extension-ui、f8、layout、models、review、selection、session-refs、sessions、settings、slash、split、tool-cards、tools；新增 [ui-strings.md](ui-strings.md)（`948f935`）。`m0-checks.md` 到 `m7-checks.md` 是当时的记录，没有改 |
| fixture（`f381eed`） | 见下"fixture" |

## fixture（从真实会话重录）

里面有 Mori 写出的文字的 fixture 用录制脚本对 DeepSeek（`mori-endpoint/deepseek-flash`）重新录了一遍，录下的文件没有手改。
10 个都是第一次就通过各自的自查、没有被拒绝（2026-10-21 12:11–12:14Z 录的）：

| fixture | 录制脚本 | 大小（旧 → 新，字节） | 变成英文的 Mori 文字 |
| --- | --- | --- | --- |
| `m4/quote-file`、`quote-file-reopen`、`quote-changed`、`quote-reply` | `m4-record.mjs --only …` | 136,902 → 115,575；17,839 → 18,639；166,262 → 126,150；76,468 → 80,605 | 引用块开头 "Quoting src/a.ts, lines 1–3:"、"Quoting your earlier reply:" |
| `m5/ref-turns`、`ref-reopen`、`ref-running`、`ref-long` | `m5-record.mjs --only …` | 124,600 → 110,080；31,271 → 33,092；232,198 → 227,997；922,159 → 959,696 | "Quoting session “…”, turns 3–5:"，每轮 `Turn N` / `User:` / `Assistant:` / `[Tool]` |
| `m7/review-reply`、`review-changed` | `m7-record.mjs` | 116,915 → 123,705；86,797 → 69,317 | F8 报告的标题、各节、"- Page: Session" 等；报告的截图是空的英文工作区（看过，没有敏感内容） |

扫描的办法（`fxscan.mjs`，在临时目录，没有进仓库）：遍历 fixture 里的每个字符串，列出既不在录制脚本的提示词里、也不在
模型输出里的中文；另用正则找旧的中文格式（"用户：""助手：""[工具]""[引用]""引用会话""引用你之前的回复""第 N 轮""第 N 行"
"约 N 字"和 F8 报告的中文字段）和像 key 的字串与字段（`sk-…`、`Bearer`、`apiKey`、`authorization`）。拿 HEAD 上旧的
fixture 试过，中文的引用块开头、会话引用和 F8 报告的字段都能报出来；新的 10 个里没有 Mori 写的中文、没有 key，剩下的
中文都是测试的提示词、取自提示词的会话名、模型的回答和脚本自己的说明；`%TEMP%\mori-real-data` 的路径不在任何 fixture 里。
组装出的提示词、会话引用的内容、`mori.ref` 条目和 F8 报告另外用眼睛核对过，约 2,100 个录制步骤（2,083 步、1,869 个事件，
数自录制日志的 RECORDED 行）没有逐个看。

没有重录的：M1、M2、M3、M6 的 fixture，M4 的 `edit-two`、`write-delete`、`stream-feedback`，M5 的 `split-*`。
它们里面没有 Mori 写的文字。M1、M2、M3、M6：录制时拿 `948f935` 在 `kernel`、`shared/protocol`、`main/index`、`main/files`、
preload 里改过的每个字串去找，旧的 fixture 里都没有（只在界面里显示的字串不会录进 fixture）。M4、M5 的这 5 个当时没有这样找
（以前这里写成都找过，是错的），审查后补做了（`leftover-scan.mjs`，在临时目录）：从 `948f935^` 的同一批文件取出至少两个汉字的
中文片段（26 个），5 个 fixture 里都没有；再从 `948f935^` 的 `quoteText.ts`、`sessionRefs.ts`、`toolTitle.ts`、`main/feedback.ts`
取片段，只在录制脚本写的提示词和场景说明里出现（"工具"、"运行"、"修改"、"会话" 这样的常用词）；按旧的格式（"用户：""助手："
"[工具]""[引用]""引用会话""引用你之前的回复""引用 … 第 N""约 N 字""界面问题 ·"）找都是 0 次。另外它们的回放（`m4-replay`、
`m5-replay`）在英文的代码上通过。M1、M2、M3、M6 的录制脚本另外完整跑过一遍确认还能用（见"结果"），录下的文件随后用
`git checkout` 还原，没有提交。

## 测试

| 测试 | 做什么 |
| --- | --- |
| `npm run check` | 类型检查、禁用词、行宽、`src/` 里不能有中文（见"交付了什么"） |
| M0–M7 的整机测试（`m0-smoke`、`m1-app` … `m7-app`，合成端点） | 同 M7，改成按英文核对；新加 6 项宽度检查（见"交付了什么"）；第二轮再加 3 项（上下文长度填 0 时的说明 2 项、选文件夹对话框 1 项） |
| M1–M7 的界面回放（`m1-replay` … `m7-replay`） | 同 M7；M4、M5、M7 回放的是这次重录的 fixture |
| M0–M7 的真实端点走查（`m0-real` … `m7-real`，DeepSeek） | 同 M7；`m0-real` 改成用现在的设置页（见"测试中发现并已修正的问题"第 3 条） |
| 录制脚本 `m1-record`、`m2-record`、`m3-record`、`m4-record`、`m5-record`、`m6-record`、`m7-record` | M4、M5、M7 重录 fixture；M1、M2、M3、M6 只确认还能用 |
| `m6-pi-config --check` | 核对 pi config 的写法与 fixture 相同 |
| 打包程序与 `out/` 的哈希比较 | 解开 `dist/win-unpacked/resources/app.asar`，逐个文件比 SHA-256 |
| `build-installer.cmd` | 走查 5：在 `f381eed` 的干净克隆里从头跑，控制台分别是 65001、936；模拟失败的各步；检查打出的安装包只带英文 |

### 结果

下表是第一轮（审查之前）的结果，`app/src` 是 `948f935` 的代码；审查后第二轮改了 `app/src`，重跑的结果见下"第二轮"。
第一轮开发构建的整机测试跑在 11:53Z 用 `44bc45b` 构建的 `out/` 上；`app/src` 从 `948f935` 到 `f381eed` 没有改过（`44bc45b`、
`f381eed` 和两处没有提交的修正都不碰 `src/`）。打包程序是在干净的 `f381eed` 上用 `npm run dist:dir` 打的（13:08–13:11Z，
`m5-app.mjs` 的修正在这之后），其中的 `npm run check` 通过；`dist:dir` 会重新构建 `out/`，解开 `app.asar` 与这份重新构建的
`out/` 的 327 个文件逐个比较 SHA-256，全部相同（`package.json` 只差 electron-builder 去掉的 `scripts` 和 `devDependencies`，
`main` 相同）；两次构建的输出里带内容哈希的资源名和大小（327 行）也一样，所以与开发构建跑的是同一份代码。

| 测试 | 开发构建 | 打包程序（`dist/win-unpacked/Mori.exe`） |
| --- | --- | --- |
| 静态检查 `npm run check` | 通过（每次改动后都跑过） | 通过（`dist:dir` 里） |
| M0 冒烟 `m0-smoke` | 16 项通过，1 项 KNOWN（pi #9129，与 M1–M7 相同） | 同左 |
| M1 整机 `m1-app` | 35 项全部通过 | 35 项全部通过 |
| M2 整机 `m2-app` | 68 项全部通过 | 68 项全部通过 |
| M3 整机 `m3-app`（含 `m3-app-live`） | 138 项全部通过（M7 时 137，加 1 项侧栏宽度） | 138 项全部通过 |
| M4 整机 `m4-app` | 61 项全部通过 | 61 项全部通过 |
| M5 整机 `m5-app` | 36 项全部通过（测试修正前一遍、修正后一遍） | 修正前 3 遍都失败（28/5、30/4、28/5），另有 2 遍带焦点记录的诊断运行（一遍 36/36 通过、一遍 28/5），所以这个时机问题不是每次都出现；修正后 2 遍 36 项全部通过（见"测试中发现并已修正的问题"第 4 条） |
| M6 整机 `m6-app-settings` / `m6-app-tools` / `m6-app-slash` / `m6-app-mcp-shared` | 114 / 142 / 73 / 49 项全部通过（settings 加 1 项、slash 加 4 项宽度检查） | 114 / 142 / 73 / 49 项全部通过 |
| M7 整机 `m7-app` | 108 项全部通过 | 108 项全部通过 |
| 界面回放 `m1-replay`（含 `m1-layout` 的 10 项）/ `m2-replay` / `m3-replay` / `m4-replay` / `m5-replay` / `m6-replay` / `m7-replay` | 57 / 98 / 60 / 26 / 20 / 82 / 24 项全部通过，每个一遍 | 不适用 |
| `m0-real`（走查 2–3） | 7 项全部通过（第 2 遍；第 1 遍脚本还是 M0 的界面，第一步就失败） | 7 项全部通过 |
| `m1-real` | 38 项全部通过 | 38 项通过：完整的一遍 37 项、1 项失败（模型行为），第 3 次（`--only 3` 的第 2 遍）通过（见下） |
| `m2-real` | 35 项全部通过 | 35 项全部通过 |
| `m3-real` | 82 项通过，1 项 KNOWN（模型行为）；`--only 5` 重跑 22 项全部通过 | 同左 |
| `m4-real` | 16 项通过：第 1 遍 13 项通过、1 项失败（走查 4 的流程超时，这一步后面的检查没跑），`--only 4` 6 项和完整的第 2 遍 16 项都通过 | 16 项全部通过 |
| `m5-real` | 16 项全部通过 | 16 项全部通过 |
| `m6-real` | 55 项全部通过（标为模型行为的几项第一次就过） | 55 项全部通过 |
| `m7-real` | 25 项全部通过 | 25 项全部通过 |
| 录制：`m4-record`（4 个场景）/ `m5-record`（4）/ `m7-record`（2） | 全部录下，没有被拒绝，提交在 `f381eed` | 不适用 |
| 录制：`m1-record`（10）/ `m2-record`（9）/ `m3-record`（11）/ `m6-record`（7） | 全部录下（`m1-record` 第 1 遍 `wrong-key` 失败，是脚本的老问题，修正后完整一遍 10 个都录下）；录下的文件已还原 | 不适用 |
| `m6-pi-config --check` | 通过 | — |
| 一键导出安装包（走查 5） | 见下"走查 5" | — |

几项重跑的说明：

- **`m1-real` 第 3 项反例（打包程序）**："失败的命令显示 'Failed · Exit code'"。完整的一遍和 `--only 3` 第 1 遍里，DeepSeek 把命令
  写成 `ls does-not-exist-dir; echo "exit=$?"`（第 2 次是 `; echo "exit code: $?"`），后面的 echo 让命令以 0 结束，Mori 显示
  "Done" 是对的（截图里模型自己说加了 echo）；第 2 遍模型照原样运行了 `ls does-not-exist-dir`，工具卡是 "Failed · Exit code 2"。
  这是模型行为，不是 Mori 的问题；但脚本没有把这一项标为模型行为，模型这样做时还会失败。开发构建一遍就过了。
- **`m3-real` 的 KNOWN**：重新打开不信任时保存的会话，问模型能用哪些工具，DeepSeek 只答了 "read, bash, edit, write"；同一项里
  Mori 这边的检查都通过（会话的工具里有 `project_hello`、会话文件的 `toolsAdded` 声明了它、模型随后调用成功）。与 M3 记下的
  KNOWN 相同。两种构建各用 `--only 5` 重跑一遍，模型都答出了 `project_hello`。
- **`m4-real` 走查 4（开发构建）**：第 1 遍在流式输出中的回复上拖选，30 秒内没有出现选区浮层的 "Feedback"（截图停在脚本向上滚动
  之后的位置，像是拖选没有发生）；`--only 4` 和完整的第 2 遍都通过，打包程序一遍通过。确切原因没查到，看起来与 M6、M7 记下的
  M4 拖选的时机问题是同一类；测试和代码都没有改。这次 `m4-replay`（`quote-file` / `quote-changed`）和 `m4-app` 都没有出现这个问题。
- `m1-real` 到 `m7-real` 的截图在 `app/test-results/m*-real(-packaged)/`（不提交）。打包程序那一遍的几个 `--only` 重跑覆盖了
  `test-results` 里的 `m1-real-packaged.json`、`m3-real-packaged.json`，完整那一遍的结果和开发构建的 `m0-real.json` 另存在
  临时目录。

`m6-mcp-cost` 没有跑（这次只改了它的注释）。

### 第二轮（审查之后，2026-10-21 16:21–17:01Z）

改了 `app/src` 的三个文件（"测试中发现并已修正的问题"第 7–8 条）和两个测试，都没有提交。`npm run check` 通过；
`npx electron-vite build` 之后在开发构建上重跑全部 11 个整机测试和 7 个界面回放，再 `npm run dist:dir`（其中的 `npm run check`
通过），在打包程序上重跑全部 11 个整机测试。`dist:dir` 重新构建的 `out/` 与解开的 `app.asar` 的 327 个文件逐个比较 SHA-256，
全部相同；它和开发构建那一次的构建输出里带内容哈希的资源名和大小（327 行）一样。真实端点的走查（`m0-real` … `m7-real`）和
录制没有重跑：这一轮只改了表单在填错时的处理、Chromium 的语言和选文件夹对话框的标题，走查用到的正常路径没有变，而且走查
要用你的 DeepSeek key。

| 测试 | 开发构建 | 打包程序 |
| --- | --- | --- |
| 静态检查 `npm run check` | 通过 | 通过（`dist:dir` 里） |
| 函数大小（TypeScript 语法树，`fnlen-all.mjs`，在临时目录） | `app/src` 全部 114 个文件、2,148 个函数里没有超过 50 行或 5 个参数的；`12f2326` 以来改过的 46 个测试文件里超过的 7 个都是原来就超的（见"未验证"） | — |
| `m0-smoke` | 16 项通过，1 项 KNOWN（pi #9129） | 同左 |
| `m1-app` | 36 项全部通过（加 1 项选文件夹对话框）；第 1 遍 35/1 | 36 项全部通过；第 1 遍 35/1 |
| `m2-app` / `m3-app` | 68 / 138 项全部通过 | 68 / 138 项全部通过 |
| `m4-app` | 61 项全部通过；第 1 遍 60/1 | 61 项全部通过；第 1 遍 60/1 |
| `m5-app` | 36 项全部通过 | 36 项全部通过 |
| `m6-app-settings` / `m6-app-tools` / `m6-app-slash` / `m6-app-mcp-shared` | 116（加 2 项上下文长度填 0）/ 142 / 73 / 49 项全部通过 | 同左 |
| `m7-app` | 108 项全部通过 | 108 项全部通过 |
| 界面回放 `m1-replay` … `m7-replay` | `m1-replay` / `m2-replay` / `m3-replay` / `m5-replay` / `m6-replay` / `m7-replay` 57 / 98 / 60 / 20 / 82 / 24 项全部通过；`m4-replay` 完整的一遍 23 项通过、1 项失败（`quote-changed` 在流式输出中拖选后等待超时，是已知的拖选时机问题，这一场景后面的检查没跑），`--only quote-changed` 单独重跑 4 项全部通过 | 不适用 |
| 语言开关（`lang-check.mjs`，在临时目录，空的临时数据文件夹，跑完已删除） | 不带参数、带 `--lang=zh-CN`、带 `--lang=zh-TW` 启动各一遍：`navigator.language` 和 `app.getLocale()` 都是 en-US，浏览器的校验文字是英文，点 "Save" 后表单下方是 "Context window must be a whole number above 0." | 同左 |

几项重跑的说明：

- **`m1-app` 的"复制代码"、`m4-app` 的"复制"**（两种构建的第 1 遍）：读回的剪贴板是空的。原因是这台机器那时锁屏了（`LogonUI`
  在运行），系统剪贴板不能用：同一时间在 PowerShell 里写剪贴板也报 "Requested Clipboard operation did not succeed."，与 Mori 无关。
  解锁后剪贴板正常，两种构建各重跑 `m1-app`、`m4-app` 一遍，都全部通过。
- 新加的 3 项在改代码之前的构建（`f381eed` 的 `out/`）上都失败过（"测试中发现并已修正的问题"第 7–8 条）。
- 另一会话的测试：这一轮没有遇到端口冲突。

### 第三轮：会话引用预览的标题（2026-10-21 17:14–17:49Z；审查后收紧检查 18:14–18:40Z）

**原因**：预览对话框 `.dialog.ref-preview` 是限高（`max-height: calc(100vh - 32px)`）的列方向 flex 容器，轮次列表
`.ref-turns` 是 `flex: 1`。标题 `.ref-preview h2` 为了省略号设了 `overflow: hidden`，这让它在列方向的自动最小高度变成 0
（其余几行没有 `overflow: hidden`，最小高度就是内容的高度，不会被压）。轮次的内容放不下时，要收缩的高度按各项的基准尺寸
分摊，标题也分到一份，被压矮；字从盒子的顶上排起，被裁掉的是字的下面（不是先前记的"顶部"）：`m5-replay` 量到一行 20px
只剩 16px 看得见。中文界面的 [M5 截图](m5/4-preview.png) 和第一轮打包程序 `m5-real` 的 `4-preview.png`（页面 1184×735）
都是这样；后者在 `app/test-results/` 里的已被第三轮的走查覆盖，`english-ui/m5-preview.png` 也换掉了，现在只在 git 里：
`7500596:docs/v0/english-ui/m5-preview.png`。内容越多压得越狠：超过 2 万字的会话，标题只剩不到 1px，整行看不见。

**修正**：`app/src/renderer/src/styles/split.css` 的 `.ref-preview h2` 加 `flex: none`（不伸缩），`overflow: hidden`、
`text-overflow: ellipsis`、`white-space: nowrap` 不变（一行、放不下时省略号），上面加了两行中文注释写明原因。
状态表 [screens/session-refs.md](screens/session-refs.md)"预览与调整范围"加了一句：标题始终完整显示在一行，会话名太长时
截断加省略号、不折行。

**检查**：`m5-helpers.mjs` 新加 `previewHeading`（量标题：`clientHeight` 与 `scrollHeight`；盒子的高度与一行的高度，
line-height 是 normal，取字的 Range 外框的高度；字排成几行；字是否比盒子宽（`scrollWidth` 大于 `clientWidth`）；computed 的
`overflow-x` 和 `text-overflow`；是否超出对话框右边；标题和对话框的右边、对话框的宽、页面的宽；轮次列表是否占满对话框）、
`headingWhole`（只有一行、`clientHeight` 不小于 `scrollHeight`、盒子不比一行矮，留 0.5px）和审查后加的 `headingTruncated`
（字比盒子宽；`overflow-x` 是 `hidden` 或 `clip`；`text-overflow` 是 `ellipsis`；只有一行；标题不超出对话框；标题和对话框的
右边都在页面里；对话框宽 min(720px, 页面宽 − 32px)；都留 0.5px。这个宽度来自 `.dialog.ref-preview` 的
`width: min(720px, 100%)`、外层 `.dialog-backdrop` 左右各 16px 的 padding 和全局的 `box-sizing: border-box`）。

| 测试 | 新加的检查 | 怎么做 |
| --- | --- | --- |
| `m5-app`（新步骤 `headingFit`，在 `longSource` 之后；要用 `longSource` 建的会话，`--only` 时两个都要选） | 预览的标题：默认窗口大小、轮次列表占满对话框时标题完整显示，只有一行、没有被压矮 | 用菜单把超过 2 万字的会话（`longSource` 建的，6 轮）引用进 B，点芯片；窗口先回到启动时的大小（页面 1184×735） |
| 同上 | 预览的标题：内容区 800×600、轮次列表占满对话框时标题仍完整显示，只有一行 | 同一个对话框，窗口内容区改成 800×600（审查后照 `m2-app` 改叫"内容区 800×600"，原来叫"最小窗口 800×600"） |
| 同上 | 预览的标题：会话名很长时只有一行，横向裁掉放不下的部分、截断加省略号、不折行，不超出对话框和窗口，对话框没有被撑宽，完整显示 | 把这个会话改名为 127 个字符的中英文名字，再打开预览（也占满对话框）；核对标题的文字是完整的名字、`headingTruncated` 和 `headingWhole`。审查前只看"放不下""省略号""不超出对话框"和 `headingWhole`，标题错改成 `overflow: visible` 也会通过（见下面的反例） |
| `m5-replay` | ref-turns：轮次列表占满预览对话框时（默认窗口大小），标题"Context · <会话名>"完整显示，只有一行、没有被压矮 | `ref-turns` fixture 的会话 C（6 轮），回放窗口 1200×800（页面 1184×735），就是截图里的那个对话框；另存截图 `ref-turns-preview` |
| `m5-real` | 走查 4：轮次列表占满预览对话框时，标题"Context · <会话名>"完整显示，只有一行、没有被压矮 | 走查 4 截图 `4-preview` 的同一时刻；审查后要求轮次列表占满对话框（原来只记在详情里，列表没占满时会白白通过） |

**先失败**（改之前：`7500596` 的 `app/src`，`npx electron-vite build` 之后）：

| 测试 | 结果 | 量到的值（标题的 `clientHeight` / `scrollHeight`，盒子 / 一行） |
| --- | --- | --- |
| `m5-replay`（17:17Z） | 20 项通过，1 项失败，就是新加的那一项 | 16 / 20，15.94px / 20px：字的下面 4px 被裁掉，与截图相同；轮次列表占满对话框 |
| `m5-app`（17:44Z） | 36 项通过，3 项失败，就是新加的 3 项 | 默认窗口（页面 1184×735）1 / 20，0.89px / 20px；800×600 时 1 / 20，0.67px；长名字 1 / 20，0.89px（一行、放不下、省略号这几样是对的，只是被压到不到 1px）。截图里标题整行不见了 |

`m5-app` 的新步骤先写成用 `setContentSize` 回到启动时 `getContentSize` 的大小；这个窗口有菜单栏，页面因此比启动时高
26px（1184×761）。改成按窗口外框（`getSize` / `setSize`）恢复、详情里记下页面的大小后，在改之前的构建上重跑了一遍（上表），
再在改之后的两种构建上各跑一遍。第一版的结果与最终版相同：改之前 36 项通过、同样 3 项失败（17:19Z），改之后开发构建、
打包程序都是 39 项全部通过（17:24Z、17:27Z）。`m5-helpers.mjs`、`m5-replay.mjs`、`m5-real.mjs` 在这之后到审查前没有再改。

收紧后的检查也在改之前的 CSS 上跑过（18:33–18:35Z，`split.css` 临时换回 `7500596` 的版本，`npx electron-vite build`）：
`m5-app` 仍是 36 项通过、同样 3 项失败，量到的值与上表相同（长名字那一项横向的几样都对，只是被压到 1 / 20）；
`m5-replay --only ref-turns` 7 项通过、1 项失败，就是新加的那一项（16 / 20）。

**反例：标题错改成 `overflow: visible`**（审查后，18:14–18:16Z）：临时把 `.ref-preview h2` 改成
`flex: none; overflow: visible; …`（不再被压矮，但放不下的字不裁掉、省略号也不起作用），`npx electron-vite build` 后跑
`m5-app`：38 项通过，1 项失败，就是长名字那一项。详情里一行、20 / 20、字比盒子宽、`text-overflow: ellipsis`、标题的盒子在
对话框里（右边 929 ≤ 952）、对话框宽 720px（页面 1184px）都对，只有 `overflow-x` 是 `visible`；审查前的条件这时会通过。
截图里会话名伸出对话框，一直伸到窗口右边外面。之后把 `split.css` 从改之前存的副本复制回来（SHA-256 相同，`git diff` 只有
这一处修正和两行注释），重新构建。

**结果**（改之后）：`npm run check` 通过（改后两次，`dist:dir` 里又一次；收紧后 18:17Z 一次，`dist:dir` 里又一次）。
17:25Z `npm run dist:dir`，`app.asar` 里是改后的 CSS；最后一次构建的 `out/` 与解开的 `app.asar` 的 327 个文件逐个比较
SHA-256，全部相同。收紧后 18:22Z 又 `npm run dist:dir` 一次，`out/` 与 `app.asar` 的 327 个文件同样逐个相同（跑完改之前的
CSS 之后的最后一次构建也比较过）。

| 测试 | 开发构建 | 打包程序（`dist/win-unpacked/Mori.exe`） |
| --- | --- | --- |
| `m5-app` | 39 项全部通过（原来 36 项 + 3 项）；收紧后 39 项全部通过（18:18Z，最后一次构建上 18:36Z 又一次） | 39 项全部通过；收紧后 39 项全部通过（18:24Z） |
| `m5-replay` | 21 项全部通过（原来 20 项 + 1 项）；收紧后 21 项全部通过（18:20Z，18:38Z 又一次） | 不适用 |
| `m5-real`（DeepSeek，`--source %TEMP%\mori-real-data`） | 17 项全部通过（原来 16 项 + 1 项），一遍就过；收紧后 17 项全部通过，一遍就过（18:26–18:30Z） | 17 项全部通过，一遍就过（17:37Z，收紧之前的版本；那一遍的详情里轮次列表占满对话框、标题 20 / 20，收紧后的条件也满足，但没有用收紧后的脚本重跑） |

`m5-real` 用的是脚本复制出来的临时数据目录（`scratchUserData`：`credentials.json`（加密的 key）、`Local State`、
`pi/models.json` 和 `pi/settings.json`，没有读 key），每遍跑完都已删除。三遍里轮次列表都占满了对话框，标题 20 / 20、
盒子 20px。

**截图（都看过）**：改之前 `m5-replay` 的 `ref-turns-preview`（字的下沿被切）、`m5-app` 的 `4-heading-default`、
`4-heading-800x600`、`4-heading-long-name`（标题整行不见）；改之后 `m5-replay` 的 `ref-turns-preview`，`m5-app` 两种构建的
`4-heading-default`、`4-heading-800x600`（标题完整，"Context · plain 第 1 条 这是一条很长的你…"）、`4-heading-long-name`
（一行，末尾 "…on a sin…"，对话框没有变宽），`m5-real` 两种构建的 `4-preview`（"Context · 用一句话介绍你自己。不要调用任何工具。"
完整）。[english-ui/m5-preview.png](english-ui/m5-preview.png) 换成了打包程序这一遍的 `4-preview`。收紧后又看了：反例的
`4-heading-long-name`（会话名伸出对话框和窗口）、收紧后打包程序的 `4-heading-long-name`（一行，末尾 "…on a sin…"，
对话框没有变宽）、开发构建的 `4-heading-800x600`（标题完整）、`m5-real` 开发构建的 `4-preview`（标题完整）。截图在
`app/test-results/m5-app(-packaged)/`、`m5-replay/`、`m5-real(-packaged)/`（不提交；现在是收紧后那几遍的，
`m5-real-packaged/` 仍是 17:37Z 那一遍的）。

只改了这一条 CSS，影响只在预览对话框，所以只重跑了 M5 的整机测试、回放和走查。另一会话的测试：这一轮没有遇到端口冲突。

### 走查 5：一键导出安装包

都在 `english-ui` `f381eed` 的干净克隆里，从命令行运行 `cmd /c build-installer.cmd --no-open --no-pause`，输出重定向到文件。
修正后的脚本是复制进克隆的。安装包没有运行、没有安装。

| 项 | 结果 | 说明 |
| --- | --- | --- |
| 5 步走完，`f381eed` 的脚本，控制台 65001 | 通过 | 226.6 秒，退出码 0，`npm run dist` 里的检查通过；`release\Mori Setup 0.0.1.exe` 141,323,023 字节。输出 421 行，没有中文、没有 cmd 的报错，非 ASCII 的只有 vite 的 ✓（U+2713）和 electron-builder 的 •（U+2022） |
| 5 步走完，`f381eed` 的脚本，控制台 936 | **失败**（已修正，见"测试中发现并已修正的问题"第 5 条） | 退出码 0、安装包也打出来了，但 cmd 把两段中文 REM 注释当命令执行，打出 "'被替换，其他版本保留。' is not recognized…"（`npm run dist` 之后）和 "'下等待按键，让人看到结果；以' is not recognized…"（`goto :finish` 时）。用不切 437 的副本对照，在 936 下照样坏，说明测试能测出这类问题 |
| 5 步走完，修正后的脚本，控制台 65001 / 936 | 通过 | 190.8 秒 / 174.4 秒，退出码 0；安装包只量了 65001 那一遍的（141,323,021 字节），936 那一遍的被它覆盖、没有量（别的几次构建量到的是 141,323,023 和 141,323,019 字节）；两份输出都是 421 行，没有中文和 cmd 的报错；结束后控制台回到原来的代码页 |
| 失败的路径，`f381eed` 的脚本（65001） | 通过 | `--bogus`：退出码 9，"Unknown option: --bogus" 和用法；PATH 里去掉 Node：停在 `[1/5]`、"Node.js check failed."，退出码 1；在克隆的 `app/src/main/index.ts` 里放一个类型错误：TS2322 之后停在 `[3/5]`，退出码 3；只有英文 |
| 失败的路径，修正后的脚本（15 遍） | 通过 | `--bogus` 和缺 Node 在 936 / 65001 / 437 下各一遍（退出码 9、1）；第 2 步失败（克隆的 `package-lock.json` 改坏）在 936 / 65001 下退出码 2；类型错误（936）退出码 3；electron-builder 收集依赖之后第 3 步才失败（克隆里 `nsis.include` 指向不存在的文件，936）退出码 3、没有 cmd 的报错；脚本放在名字带空格和括号的文件夹里也正常；不加 `--no-pause` 时只提示一次按任意键。每次都恢复了原来的代码页，克隆的改动每次都还原 |
| 代码页压力测试（96 遍） | 修正后的脚本 48 遍全部通过 | 每个脚本生成 16 个变体（`:parse_args` 前多 1–8 行中文注释，各带和不带一次把控制台输出代码页改成 65001 的 PowerShell 调用），各在 936、437、65001 下缺 Node 运行。`f381eed` 的脚本在 936 下 16 个里坏 9 个（8 个带 PowerShell 的、1 个只是注释行数不同），437 / 65001 下 32 个都正常 |
| 安装包只带英文的安装和卸载界面 | 通过（静态检查） | 自己解析 NSIS 头（非固实、头部用 deflate 压缩）：安装程序和内嵌的卸载程序都只有一张语言表，LANGID 只有 1033；"安装""下一步""浏览""取消""卸载""完成""正在""请稍候""选定安装位置" 在原文件和解压后的头里按 UTF-16LE、UTF-8、GBK 都是 0 次；"Choose Install Location"、"&Next >"、"B&rowse..." 等英文在。对照：去掉 `installerLanguages` 打的同一个程序有 26 张语言表（含 2052），中文按 UTF-16LE 找得到（"安装" 33 次等），所以检查方法有效；只搜原文件的字节连对照都找不到，因为头是压缩的 |

M7 时 `build-installer.cmd` 失败的提示是英文和中文各一行（[m7-checks.md](m7-checks.md) 走查 5），现在只有英文。
npm 11.17 提示 6 个包的安装脚本不在 `allowScripts` 里（esbuild 0.25.12 / 0.28.2、koffi 3.3.2、electron-winstaller、protobufjs、
`@google/genai`），即没有运行；构建成功，但用这样装出来的依赖打的程序能不能正常运行（尤其 koffi）没有检查（见"未验证"）。

## 测试中发现并已修正的问题

1. **实现时的整合和审查**（`948f935` 之前）。整合这一步（各组的翻译合在一起时）修了两处：`state/actionLog.ts` 从组件引
   `KIND_ONE` 造成循环引用 → 挪到 `shared/protocol.ts`；会话菜单里 "Attach as context" 和不可用的原因挤在一起 → 两者之间留 16px。
   之后四个角度的只读审查（格式、规则、忠实度、布局）的结果里共 28 条（3、3、12、10），修正的一步按它自己的数法记为 29 条；
   都属实（有重复的合并），落实为 13 处修改，没有驳回。
   主要的：英文的已保存 key 的占位文字（约 350px）在设置页 96px 标签列旁被截断 → 设置页 760px 以下标签放到输入框上面；
   280px 一栏里 "Waiting for your approval"、"Denied · You pressed Stop" 被截断 → 工具卡状态 `max-width: max(60%, 140px)`；
   会话菜单被挤得折行 → 菜单 `width: max-content`；
   侧栏默认 220px 时状态字也被藏起 → 只在窄于 220px 时只留状态圆点；只带引用、没有自己写的字的一轮写成 "User: "（带空格）
   → 不带尾随空格；截图失败行的正则也接受直撇号 → 只认 ’（U+2019）。
2. **改测试时的审查**（`44bc45b` 之前）：两个审查共 14 条，全部修正：新的宽度阈值之间没有测试 → 加了上面说的 6 项宽度检查；
   导出开头的单复数没有查 → `m7-helpers.mjs` 查；另有测试说明和文档里的过时说法。没有发现 `app/src` 的问题。
3. **`m0-real` 还是 M0 的界面**（开发构建第 1 遍第一步就失败）：它找首页的连接面板、`.panel .ok` 等，现在有保存好的连接时
   首页是 "Open folder…" → 改成从设置页 "Edit connection" → "Test connection"（期望 `Connected · First token <N>ms`）、
   "Back to app"，打开文件夹、切到 "Allow all" 后发消息（`f381eed`）；走查 2–3 查的东西不变。
4. **`m5-app` 在打包程序上打开会话菜单不稳定**（测试的问题，没有提交）：修正前 3 遍都失败，每遍都是 `keyboardReference`
   "session-menu not visible"，连带 `restart`、`runningSource`、`longSource`，其中 2 遍 `deleteSource` 也失败。用焦点和按键的
   记录查到：测试点了一个会话行，1ms 后把焦点放到另一行，而界面在下一帧（`split.ts` 的 `focusComposer`）把焦点放进输入框，
   Shift+F10 就落在输入框里。不是 Mori 的问题 → `menuOf` 改用 `m3-helpers` 的 `openMenuOn`（先等两帧再放焦点、按 Shift+F10），
   加了中文说明；没有删或放宽检查。修正后打包程序 2 遍、开发构建 1 遍都是 36 项全部通过。另一会话的测试那时已经跑完，
   不是端口或负载的干扰。
5. **`build-installer.cmd` 在 936 的控制台里执行了注释的半句**（没有提交）：原因已单独复现：electron-builder 26.17 收集依赖时
   （`app-builder-lib` 的 `node-module-collector/nodeModulesCollector.js`）启动的 PowerShell 设 `[Console]::OutputEncoding` 为
   UTF-8 且不改回，共用的控制台的输出代码页就变成 65001（`chcp` 仍显示 437），从 936 启动的 cmd 之后就读错这份 UTF-8 文件；
   单独运行同一行 PowerShell 也能复现（936 下启动 8 处报错，437、65001 下 0 处）。第一次的修法（每次 npm 之后再 `chcp 437`）
   在 936 下让 `goto :parse_args` 找不到标签，说明从 936 启动的 cmd 即使切了 437 也受文件排版影响，于是改成：开头几行只用
   ASCII、外层在其中不跳转，记下原代码页、切到 437，设 `MORI_INSTALLER_INNER=1` 后用 `cmd /d /c` 在 437 下重新运行本文件
   （`/d` 不执行 AutoRun），内层从 `:main` 开始跑原来的内容，外层结束时恢复原代码页、原样返回内层的退出码；中文注释里写明了
   原因。文件仍是 CRLF，142 行，最长 111 个字符（`check.mjs` 不查根目录的 .cmd，是手查的）。验证见上"走查 5"。
6. **`m1-record` 的 `wrong-key` 场景**（`f381eed`）：`connection.save` 缺 M6 起必填的 `providerId`、`reasoning`、`thinkingLevel`，
   被拒绝；这是 M6 之后就有的脚本问题，与英文无关 → 补上（`providerId` 为 `mori-endpoint`），之后录到 401 "Authentication Fails"。
7. **表单校验的气泡跟 Windows 显示语言走**（审查发现，Mori 的问题，第二轮已修正、没有提交）：连接表单和模型表单的上下文长度是
   `<input type="number" min={1}>`，表单没有 `noValidate`，点 "Save" 或按 Enter 时 Chromium 先做自己的校验、拦下提交，弹出
   它自己的气泡；Mori 没有固定 Chromium 的语言，Chromium 按 Windows 显示语言选（electron-builder 打进了 `zh-CN.pak`、
   `zh-TW.pak`）。审查者在打包程序上用 `--lang=zh-CN`（中文显示的 Windows 上 Chromium 会这样选）看到 "值必须大于或等于 1。"，
   Mori 自己的 "Context window must be a whole number above 0." 只有经 "Test connection" 才看得到。→ 两个 `<form>` 加
   `noValidate`；`main/index.ts` 在 ready 之前 `app.commandLine.appendSwitch('lang', 'en-US')`（同安装包的 `installerLanguages`；
   没有另用 electron-builder 的 `electronLanguages` 去掉别的语言包，这个开关在开发构建和打包程序上都管用，也不改安装包里的文件）。
   `m6-app-settings` 加 2 项（首次启动的连接表单、添加模型的表单：填 0 点 "Save"，表单下方是 Mori 的说明）；在改代码之前的构建上
   这 2 项都失败（表单下方没有文字 / 仍是上一条 "Couldn’t save: …"），改后通过。语言开关另用一个临时脚本核对（见"第二轮"）。
8. **选文件夹对话框的标题是 Windows 给的**（审查发现，第二轮已修正、没有提交）：`mori:pick-folder` 只传了
   `properties: ['openDirectory']`，标题和按钮是 Windows 按显示语言给的 "Select Folder"（中文 Windows 上是"选择文件夹"）。
   → 加 `title: 'Select a folder'`、`buttonLabel: 'Select folder'`（"Open folder…" 和 "Add plugin from folder…" 共用，
   见"需要你确认的地方"）。`m1-app` 加 1 项：把系统对话框换成记下参数、返回取消的替身，经页面的 `pickFolder` 走真的主进程代码，
   核对标题、按钮和 `openDirectory`；改代码之前的构建上失败（只有 `properties`），改后通过。对话框的其余部分和 Windows 给的
   错误原文（`shell.openPath` 打不开的原因）仍跟 Windows 显示语言，是有意不翻的（ui-strings.md "写法约定"已写明）；
   在中文显示的 Windows 上没有试过（这台机器的显示语言是 en-US）。
9. **会话引用预览的标题被压矮**（原来就有，中文界面的 M5 截图里就有；你要求在这个会话里修，第三轮已修正、没有提交）：
   标题为了省略号设了 `overflow: hidden`，在列方向的 flex 对话框里它的自动最小高度因此是 0，轮次列表占满对话框时被一起压矮，
   字被裁掉 → `.ref-preview h2` 加 `flex: none`，一行、放不下时省略号不变。加了 5 项检查（`m5-app` 3 项、`m5-replay` 1 项、
   `m5-real` 1 项），前两个测试的 4 项在改之前的构建上失败，改之后 5 项都通过；审查后收紧了长名字和 `m5-real` 的那两项，
   标题错改成 `overflow: visible` 时长名字那一项失败，见"第三轮"。

## 与方案不同、或需要你注意的地方

1. **完成顺序**：AGENTS.md 是"状态表 → fixture → 界面测试 → 实现"，这次是"术语表 → 实现 → 测试 → fixture"。fixture 里录的是
   Mori 写出的文字（引用块、会话引用、F8 报告），要先有英文的代码才能录；术语表定下了每一处的英文，起状态表的作用。
2. **旧的中文记录不再兼容**（你的决定）：M2–M7 存下的中文 F8 报告在工作回顾里列为读不出来的记录（带原文，可以"Show in Explorer"），
   不会切成几节；旧会话里带中文引用块或中文会话引用的消息按全文显示，不再拆成芯片。反馈记录（JSON）的格式没有变，
   旧的反馈应该照样列出，里面你写的字和会话名是当时的样子。
   这几种都没有拿真的旧文件（例如你日常的 `%APPDATA%\Mori`）试过（见"未验证"）。
3. **宽度阈值按英文重新定了**（[defaults.md](defaults.md) 已登记，ui-strings.md "实现时要一起改的地方"有测量）：
   - 顶栏：760px 以下权限按钮去掉图标（模型按钮 120px 的上限仍在 720px）；660px 以下（分屏 690px 起）不显示项目名和 ›；
     600px 以下内边距收小、菜单贴右；500px 以下（原来 480px）不显示上下文用量；400px 以下权限按钮只显示盾牌图标，
     模式名放进读屏名 "Permission mode: <模式>"。思考按钮的档位（720 / 600 / 400px）不变。
   - 侧栏：窄于 220px 时会话行只显示状态圆点（状态字仍在读屏名里，悬停在圆点上），并藏起 "Ctrl+N"。
   - 设置页左侧导航 180px → 200px；设置页 760px 以下连接表单的标签放到输入框上面；Customize 页 MCP 表单的标签列
     84px → 132px；工具卡的标题至少留 56px，徽标放不下时截断加省略号；工具卡状态 `max-width: max(60%, 140px)`；
     会话菜单 `width: max-content`。
   - **还没解决的**：英文的按钮更宽，约 460px 宽的分屏一栏里，顶栏的模型按钮、"Unavailable" / Effort、"Ask each time"
     先占了位置，会话名被挤到最小的 36px（只剩约 2 个字符，见[截图](english-ui/m5-split.png)）。这个分支只保证不溢出，
     没有给会话名腾地方。你已经定了怎么改（"你决定的"最后一条：按钮移到输入框下面一行、Effort 仍单独、上下文用量改成圆环），
     在英文界面提交之后的 `composer-pickers` 分支上做。
4. **会话引用预览的标题被压矮、字的下面被裁掉**（先前记成"顶部被切掉一点"，量过之后是下面：回放里一行 20px 只剩 16px
   看得见，超过 2 万字的会话整行看不见）：中文界面和英文界面都这样，原来就有。你要求在这个会话里修（"你决定的"），
   第三轮已修正（没有提交）：`split.css` 的 `.ref-preview h2` 加 `flex: none`，状态表加了一句标题的样子；
   只重跑了 M5 的整机测试、回放和走查（见"第三轮"）。
5. **自动生成的会话名仍截到 20 个字符**（`TITLE_LENGTH`）：中文 20 个字够一句话，英文只有 3–4 个词。没有改。
6. **两处读屏名里有 " · "**："Context: src/a.ts · lines 3–5, jump to source"、"Remove context: …"（芯片上的字本身带 " · "）。
   约定说读屏名里不用 " · "，但术语表里这两条就是这样写的，照术语表。
7. **逐条对照表 `translations.json` 没有进仓库**：ui-strings.md 开头说逐条的对照在它里面，但它只在这次任务的临时目录里（864 条）。
   要留下的话需要你定放在哪（例如 `docs/v0/`），否则 ui-strings.md 那句话要改。
8. **两个过时的脚本修了**：`m0-real.mjs`（M0 的界面）和 `m1-record.mjs` 的 `wrong-key`（缺 M6 的字段），都与英文无关，见上。
   M1 的 `wrong-key.json` 是 2026-10-19 录的，没有重录（新录的会多 `mori.entry_id` 等事件，`m1-replay` 用旧的照样通过）。
9. **`m4-real` 走查 4 在开发构建上因为时机失败过一次**，`m1-real` 第 3 项反例在打包程序上要靠模型照原样运行命令，见"结果"。
10. **代码里仍叫 tools**：界面上的 "Customize" 页，代码的文件名和 CSS 类名（`ToolsPage.tsx`、`nav-tools`）、状态表
    `screens/tools.md` 没有改名。
11. **旧的检查记录和截图没有改**：`m0-checks.md` 到 `m7-checks.md` 和 `docs/v0/m1/` 到 `m7/` 的截图是当时的中文界面，
    留作记录；其中 m7-checks.md 走查 5 说的"英文和中文写明是第几步"、ui-strings.md 里 `build-installer.cmd` 只说切 437 的那句，
    已由这次的修正取代（ui-strings.md 已跟着改）。

## 未验证

- **你的走查**：这次的，以及还没签收的 M2–M7。到现在为止只有测试脚本和几张截图（录制时 F8 报告的截图、走查的出错截图等）
  看过英文界面，没有人从头到尾用眼睛看过每一屏的英文是否通顺、是否被截断。几张打包程序走查时的截图（第一轮，`f381eed`；
  第二轮的改动不影响这几屏）：[M4 选区芯片](english-ui/m4-chip.png)、[M5 分屏](english-ui/m5-split.png)、
  [M5 会话引用预览](english-ui/m5-preview.png)（第三轮修正后打包程序走查时的截图；第一轮那张在 `7500596` 里）、
  [M6 设置页](english-ui/m6-settings.png)、
  [M7 工作回顾](english-ui/m7-issue.png)。
- **M2–M7 的走查要用英文构建新建的数据**：方案第 7 节 M4 走查 3（重启后芯片仍能点回）、M5 走查 5（点引用跳回 C）、
  M7 走查 1–2（M2 起的 F8 报告都在 "UI issues" 里）照字面要在你现有的 `%APPDATA%\Mori` 上做，但按你定的不兼容
  （[app-v0.md](../app-v0.md) 第 11 节"显示语言"），M2–M7 的构建存下的 F8 报告会列为 "Couldn’t read the record <文件名>"，
  旧消息里的中文引用块（"引用 … 第 N 行：""引用会话“…”第 N 轮："）按全文显示、没有芯片。所以这些走查要用英文构建新建的
  会话、引用和 F8 报告；反馈记录（JSON）的格式没有变，旧的反馈应该照样列出（没有试过）。
- **会话引用预览标题的修正**（第三轮）只查了这个对话框。别的列方向、限高的弹层里有没有同样"`overflow: hidden` 的一行被压矮"
  的写法没有逐个查（只看了 F8 报告框：它的标题没有 `overflow: hidden`，框自己滚动）。第三轮只重跑了 M5 的测试，
  其他整机测试、回放、走查和一键导出安装包没有用这份代码再跑；打出的安装包也没有重新打（只打了 `dist/win-unpacked`）。
  审查后收紧的检查没有在打包程序上跑 `m5-real`（只跑了开发构建）。
- **`m4-real` 走查 4 第一次失败的原因不知道**（开发构建，第一轮）：拖选后 30 秒内没有出现选区浮层，重跑都通过；与 M6、M7 记下的
  M4 拖选时机问题像是同一类，没有查到确切原因，测试和代码都没有改。
- **`m1-real` 第 3 项反例没有标为模型行为**：DeepSeek 在命令后面加 `; echo …` 时命令以 0 结束，Mori 显示 "Done" 是对的，但这一项
  会记为失败；以后照样会这样失败，要重跑到模型照原样运行命令（"结果"里的说明）。
- **两个测试辅助函数早就超过 50 行，这次又碰了**：`tests/ui/harness/replay.js` 的 `createReplayBridge` 现在 199 行（`12f2326`
  时 198 行），`tests/ui/page.mjs` 的 `pageHelpers` 128 行（与 `12f2326` 相同，这次只改了里面的字）；另有 4 个测试函数早就超过
  50 行、这次行数没有变（`m1-real` 的 `item9` 51 行、`m4-app` 的 `streamingFeedback` 53 行、`m4-record` / `m5-record` /
  `m6-record` 的 `installRecorder` 57 / 59 / 59 行）。都没有拆（`app/src` 里没有超过的，见"第二轮"）。
- **一键导出安装包**：安装包没有运行、没有安装，英文的安装和卸载界面只是从解压的 NSIS 头静态检查的（有对照）；没有在资源管理器里
  真的双击（每次都是从命令行运行、输出重定向到文件，所以没看到结束时等待按键、打开 `release\` 的窗口，也没看到 ✓、• 在真的
  437 控制台窗口里的样子）；没有用空的下载缓存跑（npm 缓存、Electron 44.9.0 的 zip、electron-builder 的 NSIS / 7zip 都已在缓存里）；
  agent 的 shell 设了代理、`NODE_EXTRA_CA_CERTS`、`npm_config_no_proxy` 和 `NoDefaultCurrentDirectoryInExePath=1`（后者让按文件名
  运行 `build-installer.cmd` 找不到，包装脚本里清掉了），与你的控制台不同；仓库路径里有 `& ^ | < >` 时不支持（原来就这样）；
  `--bogus --no-pause` 仍会提示按任意键（参数解析停在不认识的参数上，原来就这样，没有改）；npm 没有运行安装脚本的 6 个包
  对打出的程序有没有影响没有检查；内网机器上离线安装（同 M7）。
- **修正后的 `build-installer.cmd` 为什么可行**：cmd 内部为什么在 936 启动、切到 437 之后仍读错文件，没有证明；修法靠的是复现——
  从 437 启动的 cmd 在每次测试里都正常，包括控制台的输出代码页被改成 65001 之后。
- **第二轮之后没有重跑的**：真实端点的走查（`m0-real` … `m7-real`）、录制、一键导出安装包（走查 5）都是在第一轮（`f381eed`
  的 `app/src`）上做的；第二轮改了 `app/src`，这些没有再跑（理由见"第二轮"）。打出的安装包也没有用第二轮的代码重新打。
  整机测试和界面回放在第二轮整体重跑过（`m5-app.mjs` 的修正也包括在内）。第三轮（`7500596` 之后的预览标题修正）只重跑了
  `m5-app`、`m5-replay` 和 `m5-real`，`m5-real` 是这些真实端点走查里唯一跑在第二轮以后的代码上的。
- **中文显示的 Windows 上没有试过**：Chromium 固定用英文是用 `--lang=zh-CN` 启动模拟的（Mori 设的开关盖过了命令行上的），
  这台机器的显示语言是 en-US；选文件夹对话框的其余部分和 Windows 的错误原文在中文 Windows 上会是中文（有意不翻）。
  `navigator.languages` 第二项仍是系统的 zh-Hans-CN（Mori 没有用到它）。
- **真的旧记录**：M2–M7 的构建写下的中文 F8 报告、中文引用块的会话、旧的反馈没有拿来在英文界面里打开过（"与方案不同"第 2 条）。
- **fixture 的中文扫描是启发式的**（见"fixture"），约 2,100 个录制步骤（2,083 步）没有逐个看；`ref-turns` 第 2 轮模型除了 read 还跑了 bash
  （`ls` / `find`），脚本允许、只引用第 3–5 轮，与旧的 fixture 不同。
- **每个录制、回放、整机测试大多只跑了一遍**，一遍通过说明不了以后重录时被拒绝的频率。
- **`m1-record` 没有自己的结果检查**，"RECORDED" 只说明场景跑完没有报错，除了上面手查的几处，录下的结果没有核对；
  M1、M2、M3、M6 的新录制已还原，没有拿它们回放。
- `m0-real` 修改后的 `--setup` 模式没有跑；`m6-mcp-cost` 没有跑。
- **同一台机器上的另一个会话**：跑测试的时候，主检出 `D:\code\mori\app` 里另一个 Claude 会话在跑它自己的界面测试
  （`v1-models-*`，带合成端点和 Electron，有时跑 `m3-app`、`m2-replay`、`m0-smoke`）。没有遇到端口冲突，看到的失败都查到了
  与它无关的原因；但 `m4-real` 走查 4 失败的那一遍它是不是也在跑不知道。
- `m4-replay` 的拖选时机问题第一轮没有出现，第二轮完整的一遍里 `quote-changed` 出现了一次（单独重跑通过），原因仍没查到（同 M7）。
