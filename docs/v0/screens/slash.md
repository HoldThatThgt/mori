# 输入框的"/"补全（M6）

依据：方案 5.13 最后一条"输入框 '/'：列出 pi 的提示词模板和技能命令，选中后插入"；pi 怎样展开见 [../m6-checks.md](../m6-checks.md)。

## 来源

| 来源 | 内容 |
| --- | --- |
| `session.commands`（这个会话） | pi 的提示词模板（`session.promptTemplates`：名字、说明、`argument-hint`）和技能命令（`resourceLoader.getSkills()`，写成 `skill:名字`，带说明）；pi 设置 `enableSkillCommands` 为 false 时不列技能（与 pi 终端相同）。只列这个会话加载了的（启用的、信任的项目里的）（协作模式：见 docs/specs/parallel-agents-taskboard.md §5.1：Mori 的 `/team` 不列在这里，优先于同名的提示词模板和技能，见 ../../v1/screens/team-switch.md） |
| 你输入的字 | 输入框的文字以 `/` 开头、光标在第一个空白之前时，`/` 后面的字是筛选词 |

## 状态表

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 关闭 | 输入框不以 `/` 开头，或光标已经在第一个空白之后 | 没有补全列表 | — |
| 读取中 | 刚打出 `/`，`session.commands` 还没返回 | 列表里一行"Loading…" | 继续打字；Enter 照常发送 |
| 列表 | `session.commands` 的结果按筛选词过滤（名字以筛选词开头的在前，包含它的在后，不分大小写） | 浮在输入框上方（读屏名"Slash commands"），分"Prompt templates""Skills"两组；每项 `/名字`、`argument-hint`（有时）和说明；第一项高亮 | ↑ ↓ 移动（首尾循环）；Enter 或 Tab 插入；点一项插入；Esc 关闭 |
| 没有匹配 | 过滤后为空 | "No matching prompt templates or skills" | 继续打字；Esc；Enter 照常发送（例如扩展命令 `/名字` 不在列表里，照 Claude 桌面版直接发出） |
| 会话没有任何模板和技能 | 结果为空 | "This session has no prompt templates or skills. Add them in Customize." | Esc；Enter 照常发送 |
| 读取失败 | `session.commands` 报错 | 原文 | Esc |
| 插入后 | 你选了一项 | 输入框的第一个词换成 `/名字 `（带一个空格），光标在末尾；列表关闭；不发送 | 接着写参数，Enter 发送 |
| 输入法组字中 | `compositionstart` 到 `compositionend` | 列表照常显示，但 Enter 只选词（不插入、不发送） | — |
| 会话没打开 / 后台进程退出 | 会话不能发送时 | 不出列表 | — |
| 带引用芯片 | 输入框里有引用芯片（`draftRefs`），或正在读取的会话引用（`refPending` 里没有 `problem` 的项）。发出的全文以引用块开头，pi 只展开以 `/` 开头的消息（m6-checks.md），命令不会展开 | 列表里只有一行"Prompt templates and skills don’t work in a message with attached context. Remove the context first."，没有可选项；不读 `session.commands`。Enter 照常发送原文（同"没有匹配"） | 移除芯片后列表照常；Esc 关闭；打空格后接着写，Enter 发送原文 |

Esc 先关闭列表（浮层栈，方案 5.8），不停止生成；列表里有可选的项时 Enter 只插入、不发送，没有可选的项时 Enter 照常发送。

## 发出之后：你的消息怎样显示

pi 记进会话、发给模型的都是展开后的文字（m6-checks.md），所以：

| 情况 | 来源 | 必须可见 |
| --- | --- | --- |
| 技能命令 | 你的消息以 `<skill name="名字" location="路径">` 开头（pi `_expandSkillCommand` 的写法） | 照 pi 终端（`SkillInvocationMessageComponent`）：气泡里一行"Skill · <名字>"，后面是你写的参数；"Expand"看技能正文（展开后按钮是"Collapse"）。会话名（没起名时取第一条消息）用"/skill:名字 参数"算 |
| 提示词模板 | 展开后的模板正文（pi 不保留原来的 `/名字`） | 气泡里是展开后的全文（与 pi 终端相同） |
| 技能命令被撤回或放回输入框 | 排队区的撤回、停止和 Esc（`session.clearQueue` 返回 pi 排队的展开后文字），错误卡的"Put your last message back in the message box"（`lastUserText`） | 输入框里放回"/skill:名字 参数"（与排队区、气泡的写法一致），不放回展开后的 `<skill>` 块 |

## 照 Claude 桌面版

| 交互 | 做法 |
| --- | --- |
| 打出 `/` | 输入框上方弹出命令列表，随打字过滤；↑ ↓ 选择，Enter / Tab 选中；Esc 关闭；选中后插入、不直接发送（方案"选中后插入"） |

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 列表 | `data-testid="slash-menu"`（`role="listbox"`）；项 `role="option"`，`data-name` 为不带 `/` 的名字（`skill:名字` 或模板名），`data-kind` 为 `prompt` / `skill`，高亮的 `aria-selected="true"` |
| 带引用芯片时的说明 | 列表里 `data-testid="slash-quoted"` |
| 技能调用的气泡 | `data-testid="skill-invocation"`，`data-skill` 为名字 |
