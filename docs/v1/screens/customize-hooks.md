# Customize › Hooks：按事件列出的钩子、Open in default app、有问题的条目与 Disable all hooks

依据：负责人 2026-10-28 的要求 "make a hook system following claude's design" 与他对 Claude 的回答（钩子放在两份 pi 设置的 `hooks` 键里，Customize 加 `Hooks` 一节：
每条钩子一行的只读列表——事件、matcher、命令、User / Project——与 Open in default app，加一个 `Disable all hooks` 开关）；[钩子构建规格](../../specs/hooks.md)（下称“规格”）§4、§8.1、§9。
补充 [v0 tools.md](../../v0/screens/tools.md) 的外框（分节、顶部的说明、跟随的会话、项目信任）。照 Claude Code 的 `/hooks`（只读、按事件分组、每条标出来源；要改就编辑 settings.json）。
界面文字为英文；规格没给、本表定的写作“（临时，走查时可以改）”。

## 来源

| 来源 | 内容 |
| --- | --- |
| `hooks.get { sessionId? }` 的结果 `HooksInfo`（规格 §8.1） | `userFile`、`userExists`；`projectFile`、`projectExists`（受信任时才有）；`projectTrust`；`hooks[]`（`event`、`matcher`、`command`、`scope`、`file`、`path`）；`problems[]`（`file`、`path`、`message`）；`readErrors[]`（`file`、`message`）；`disabled`（`value`、`setIn`、`readOnly`） |
| `hooks.setDisabled { sessionId?, disabled }` 的结果 | `{ error: null }`，或报错原文（规格 §8.1：在 pi 的文件锁里只改用户级 `settings.json` 的 `disableAllHooks`，同 `defaultTools.ts` 的 `writeDefaultTool`） |
| Customize 跟随的会话 | 同 v0 tools.md“跟随哪个会话”：当前会话；还在打开中时没有 pi 会话 id；打开失败或没有会话时没有。项目信任按 `toolsTrust`（同 Skills、MCP） |
| 主进程 `openPath` | Open in default app（`.json` 照常打开，不是 `RUNNABLE` 里的类型，`app/src/main/files.ts:82-112`） |
| 界面的后台进程状态 | 退出、重新载入中、连上（同 customize-agents-md.md“后台进程退出时”） |
| 你的操作 | 切换分节、Open in default app、按开关、离开 |

这一节自己读 `hooks.get`，不等 `tools.get`（同 Agents、Instructions），`tools.get` 读取失败时它照常可用。每次进入这一节、跟随的会话换了、按开关之后、`Restart` 连上后重新读取；不监视文件。

## 位置

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| Customize 的分节 | 跟随的会话 | 左侧分节列表里 `Hooks`（`data-section="hooks"`）在 `Plugins` 之后、`Instructions` 之前：有会话时 `Built-in tools`、`Skills`、`Agents`、`MCP`、`Plugins`、`Hooks`、`Instructions`；没有会话时 `Skills`、`Plugins`、`Hooks`、`Instructions`（这一节不需要会话，只列用户级）。`Instructions` 仍是最后一节（负责人 2026-10-26 定）（位置临时，走查时可以改） | 切换分节（点、Tab、↑ ↓，同 v0） |
| 从侧栏进入 Customize | 你点了侧栏 `Customize` | 照旧落在第一节，不落在 `Hooks` | — |
| 顶部 | 同 v0 tools.md | `Back to app`、`Customize`、跟随的会话；没有会话时 `No open session. Only user-level skills, plugins, hooks, and instructions are listed.`（2026-10-28 改：加了 `hooks`）；下面一行 `Changes apply to new sessions. Sessions already open aren’t affected.` 与 `New session`（钩子也是建会话时读一次，规格 §4.6） | 同 v0 |
| 标题与第一行 | — | 标题 `Hooks`；标题下第一行（`hooks-intro`）`Shell commands that run at set points in a session, such as before a tool runs or when a response ends. Mori reads them from the hooks key in settings.json, in Claude Code’s format.`（临时，走查时可以改）；读取中、读取失败时也在 | — |

## 列表

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 读取中 | `hooks.get` 还没返回（第一次） | 标题、第一行，下面 `Loading…`；开关不可用 | — |
| 读取失败 | `hooks.get` 报错（第一次读） | `Couldn’t load hooks: <原文>`；没有列表与开关 | 换到另一节再回来；后台进程退出造成的，`Restart` 连上后自己重新读取 |
| 重新读取失败 | 已经读到过，之后的 `hooks.get`（按开关之后、跟随的会话换了、`Restart` 后）报错 | 同一句原文显示在这一节顶部，下面仍是读到过的列表与开关（同 customize-agents-md.md“重新读取失败”） | 换到另一节再回来 |
| 没有钩子 | `hooks` 为空，`problems`、`readErrors` 也为空 | `hooks-empty`：`No hooks yet. Add them to the hooks key in <userFile>, in Claude Code’s format.`；有受信任的项目时为 `No hooks yet. Add them to the hooks key in <userFile> or in this project’s .pi/settings.json, in Claude Code’s format.`（`<userFile>` 写实际路径；临时，走查时可以改）；文件存在时后面一个 `Open in default app`（打开 `userFile`） | Open in default app |
| 列表 | `hooks` | 按事件分组（`hooks-event`，组标题是事件名原文，如 `PreToolUse`，按规格 §6.1 的顺序，没有钩子的事件不出现）。每条钩子一行（`hook-row`）：`Matcher: <matcher>`（`.hook-matcher`；`matcher` 为 `null`、`""` 或 `*` 时 `Matcher: All`；`UserPromptSubmit`、`Stop` 的行没有这一项，规格 §4.3），命令全文（`.hook-command`，等宽字体，保留空格，太长时折行，不截断），来源 `User` / `Project`（`.hook-scope`），右边 `Open in default app`（`hook-open`）。同一事件里用户级在前，各按文件里的顺序。同一条命令在两份文件里都有时两行都列（运行时只跑一次，规格 §5.5） | Open in default app（打开这一行的 `file`，即定义它的 settings.json，不打开命令里的脚本） |
| 用户级与项目的 | `hooks[].scope` | 两种行一样画，只有 `.hook-scope` 不同；项目的行也能 Open in default app（打开项目的 `.pi\settings.json`）。不能在这里改任何一条（负责人定只读；照 Claude Code 改文件） | Open in default app |
| 有问题的条目 | `problems` 不为空 | 列表下方警示色（`hooks-problems`）：一行 `These hooks don’t run:`，下面每个问题一行（`.hook-problem`）`<文件> · <path>: <message>`，例如 `C:\Users\…\pi\settings.json · hooks.PreToolUse[0].hooks[0]: Mori runs command hooks only (type “prompt”).`（原文规格 §4.5）；每行右边 `Open in default app`（打开那个文件）。有问题的条目不在上面的列表里 | Open in default app |
| 设置文件读不出 | `readErrors` 不为空（文件不是 JSON） | 这一节顶部警示色（`hooks-read-error`）每个文件一行 `Couldn’t read hook settings: <path>: <原文>`，后面 `Open in default app`；读不出的是用户级文件时开关不可用，开关下面一行 `Fix settings.json first: it can’t be read.`（临时，走查时可以改）；这份文件里的钩子不列出、不跑 | Open in default app；改好文件后换到另一节再回来 |
| 打开失败 | 主进程 `openPath` 的错误（同 customize-agents.md“打开失败”） | `Couldn’t open this file with the default app: <原文>`（`hook-open-error`，`.form-message.error`），在点的那个 `Open in default app` 所在的那一行（列表的行、有问题的条目、读不出的文件、空列表的那一句）下面（位置临时，走查时可以改） | — |
| 不信任 | 跟随的会话的项目没有被信任（或没有回答）：`projectTrust` 为 `untrusted` 或 `unasked`（按 `toolsTrust`：会话打开时为 `none`、之后才出现项目配置的也是 `unasked`，照新会话的判断，这一页说的就是新会话），`projectFile` 为 `null` | 顶部仍有 v0 的 `This workspace isn’t trusted, so its skills and settings aren’t listed`（项目的钩子就是设置）；这一节开关之后、列表之前一行 `hooks-untrusted`：`Hooks don’t run in this workspace because it isn’t trusted.`（规格 §11.5 的原文；新会话一个钩子都不跑，用户级的也不跑，规格 §4.2、§0 第 23 条）；用户级的行照常列出，每行变淡（同开关开着时的 `.hooks-off`；临时，走查时可以改），仍能 Open in default app；项目的 `.pi\settings.json` 写了钩子也不读、不列、不跑（规格 §4.2） | Open in default app |
| 没有要信任的项目资源 | 跟随的会话的文件夹里没有要信任的项目资源：`projectTrust` 为 `none`，`projectFile` 为 `null` | 只有用户级的行，不变淡；没有 `hooks-untrusted` 一行，顶部也没有信任的说明；这些行在新会话里照跑（规格 §0 第 23 条） | Open in default app |
| 没有跟随的会话 | 没有打开的会话，或它打开失败 | 只列用户级（`hooks.get` 不带会话）；开关照常可用（它只写用户级文件） | 同上 |
| 跟随的会话还在打开中，或换了会话还没读到 | 跟随的会话没有 pi 会话 id，或最近读到的结果不是这个会话的；后台进程在 | 先列不带会话读到的用户级行；用户级之后一行 `hooks-project-loading`：`Loading this project’s hooks…`（临时，走查时可以改）；会话打开好后带会话重新读取 | — |

## Disable all hooks

开关在标题与第一行之后、列表之前（`hooks-disable`，`role="switch"`，读屏名称 `Disable all hooks`，旁边文字 `Disable all hooks`），下面一行说明 `New sessions don’t run any hooks while this is on.`（临时，走查时可以改）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 关着 | `disabled.value` 为假 | 开关关着；列表照常 | 打开 |
| 开着 | `disabled.value` 为真（用户级写了 `"disableAllHooks": true`，项目没有写） | 开关开着；列表照常列出，每行变淡（`.hooks-off`），仍能 Open in default app；不另加文字 | 关掉 |
| 写入中 | `hooks.setDisabled` 和之后的重新读取还没结束 | 开关显示按下后的样子、不可用（不能连按） | — |
| 写入成功 | `{ error: null }`，重新读取 | 开关是新的样子；`settings.json` 里只有 `disableAllHooks` 变了（打开时写 `true`，关掉时去掉这个键），别的键与顺序不变；开着的会话照旧按打开时的跑，之后新建、重新打开的会话按新的（顶部那一行说的） | — |
| 写入失败 | 命令报错：`settings.json` 不是 JSON 或不是对象（原文带文件路径）、拿不到 pi 的文件锁、项目设置改了它（只在界面过时时出现） | 开关下面一行 `Couldn’t save: <原文>`（`.form-message.error`）；开关回到原来的样子；文件不变 | 改好文件后再按 |
| 本项目的设置改了它 | `disabled.setIn` 为 `project`（受信任项目的 `.pi\settings.json` 写了 `disableAllHooks`；照 Claude 的设置优先级，项目盖过用户级，规格 §4.4） | 开关显示生效的值、不可用；下面一行 `Turned on in this project’s .pi/settings.json. To change it, edit that file.`（为假时 `Turned off in …`，同内置工具与技能的写法，`.tools-row-note`）；悬停在不可用的开关上提示同一句；`value` 为真时每行变淡 | — |
| 用户级文件读不出 | `disabled.readOnly` 为真、`setIn` 不是 `project`（`readErrors` 里有 `userFile`） | 开关不可用，下面一行 `Fix settings.json first: it can’t be read.` | 去改文件 |
| 操作记录 | `hooks.setDisabled`（规格 §8.5） | F8 报告的 Recent activity 每按一次记一条：打开时 `Disable all hooks`，关掉时 `Enable all hooks`；`hooks.get` 不记 | — |

## 后台进程退出时

同 [customize-agents-md.md](customize-agents-md.md)“后台进程退出时”的做法（临时，走查时可以改）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 已在 Customize › Hooks | 界面的后台进程状态：退出 | 读到过的列表、问题与开关都留着，不重新读取；项目那一部分还没读到时 `hooks-project-loading` 一行改为 `Mori’s background process crashed. Restart it to continue.`；页面顶部是已有的全局退出横幅，不另加；退出时还没返回的那一次 `hooks.get` 照“重新读取失败”显示原文 `Mori’s background process crashed (exit code <n>)`；开关照常可点，失败时 `Couldn’t save: Mori’s background process crashed (exit code <n>)`、开关回去；退出后换到别的节再回来：这一节读取失败，按“读取失败”显示原文 | `Restart`；`Back to app` |
| `Restart` 之后 | 后台进程重新载入中、连上、会话重新打开 | 重新载入中不重新读取；连上后不带会话读一次，会话打开好后带会话再读 | — |

## 反例

- 列表里没有添加、编辑、删除、单独停用某一条的按钮；点一行不展开表单（负责人定只读）。
- Open in default app 打开的是 settings.json，不运行命令里的脚本，也不打开脚本。
- 不信任的项目里写的钩子不出现，也没有给它们的 `hooks-problems`（`These hooks don’t run:`）一块（Mori 没有读那份文件）；
  `hooks-untrusted` 那一行说的是整个工作区，不是这一块。
- 有问题的条目不在列表里；列表里的每一条在新会话里都会跑（`Disable all hooks` 开着时、工作区不被信任时除外）。
- `.claude/settings.json` 里的钩子不出现。
- `Disable all hooks` 开着时列表不消失、不清空。
- `Hooks` 不是最后一节；从侧栏进入不落在它。
- `tools.get` 读取失败时这一节照常可用。

## 本表定下的界面细节

规格与负责人的话没给、本表定的（临时，走查时可以改；登记在 [defaults.md](../defaults.md) 的“钩子”一节“Customize 的位置与文字”一行）：分节的位置（`Plugins` 之后、`Instructions` 之前）、没有会话时也在；第一行的句子；空列表的句子；
`Matcher: All` 的写法、`UserPromptSubmit` 与 `Stop` 不显示 matcher；按事件分组、组内用户级在前；问题的写法 `<文件> · <path>: <message>` 与 `These hooks don’t run:`；读不出文件时的两句；打开失败那一句的位置；开关的位置与说明一句；开着时行变淡；
不信任（`untrusted`、`unasked`）时 `Hooks don’t run in this workspace because it isn’t trusted.` 一行的位置（句子出自规格 §11.5）与用户级的行变淡；项目一部分还没读到时的 `Loading this project’s hooks…`；后台进程退出时的做法。照负责人定的：只读列表、事件、matcher、命令、User / Project、Open in default app、`Disable all hooks`。照 Claude 的：按事件分组、标出来源、要改就编辑文件、项目设置盖过用户级的 `disableAllHooks`。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 分节 | `[data-testid="tools-nav"] button[data-section="hooks"]` |
| 这一节 | `data-testid="hooks-section"`；第一行 `hooks-intro` |
| 分组与行 | `hooks-event`（`data-event`）；`hook-row`（`data-event`、`data-scope` 为 `user` / `project`）；行里 `.hook-matcher`、`.hook-command`、`.hook-scope`、`hook-open` |
| 打开失败 | `hook-open-error`（`.form-message.error`，`role="alert"`） |
| 空、问题、读不出 | `hooks-empty`；`hooks-problems`（每行 `.hook-problem`，`data-file`）；`hooks-read-error` |
| 开关 | `hooks-disable`（`role="switch"`，`aria-checked`）；说明与项目设置的说明 `.tools-row-note`；写入失败 `.form-message.error`；开着时列表的类名含 `hooks-off` |
| 项目一部分还没读到 | `hooks-project-loading` |
| 不信任的说明 | `hooks-untrusted`（不信任时列表的类名同样含 `hooks-off`） |
