# Customize › AGENTS.md：用户级 AGENTS.md 的编辑器、项目加载的文件与 2,000 token 的提醒线

依据：2026-10-26 负责人走查（[walkthrough-1026-checks.md](../walkthrough-1026-checks.md)）的 M4“the AGENTS.md should put in customize rather setting”
与 M15“budget for AGENT.md is too short, expand to 2000tokens”，包的检查记录 [walkthrough-1026/WP-07.md](../walkthrough-1026/WP-07.md)；
提示词分层与记忆构建规格（[memory.md](../../specs/memory.md)，下称“规格”）§10.3（token 数与提醒线）、§10.8、§10.9。
取代 [v0 settings.md](../../v0/screens/settings.md) 的“AGENTS.md”一节（v0 M6，原来在设置页）与 [settings-issues.md](settings-issues.md) 的“AGENTS.md 节的 token 数”；
补充 [v0 tools.md](../../v0/screens/tools.md) 的外框（分节、顶部的说明、离开）。内容与 v0 相同的行原样搬过来，改了的行标“（2026-10-26 改）”。
界面文字为英文；规格没给、本表定的写作“（临时，走查时可以改）”。

## 来源

| 来源 | 内容 |
| --- | --- |
| `agents.get { sessionId? }` 的结果 | `userPath`、`content`（文件不存在时 null）、`effectivePath`（agentDir 里生效的文件，没有时 null）、`loaded: { path, tokens }[] \| null`（带 `sessionId` 时是这个会话的资源加载器实际加载的文件，去掉 agentDir 里的那个；不带时 null）、`userTokens`、`total`（规格 §10.3） |
| `agents.save { content }` 的结果 | 写 `<agentDir>\AGENTS.md`（UTF-8） |
| Customize 跟随的会话 | 同 v0 tools.md“跟随哪个会话”：当前会话（分屏时焦点所在的那一栏）；还在打开中时没有 pi 会话 id；打开失败或没有会话时没有。这一节与另外四节跟随同一个会话（2026-10-26 改：原来在设置页时只在进入这一节的那一刻取一次焦点会话） |
| `shared/memory.ts` 的 `AGENTS_LIMIT` | 2000：合计的提醒线（负责人 2026-10-26 定，不是临时默认值；记忆的四种仍是 `MEMORY_LIMIT` 500） |
| 主进程 `openPath` | Open in default app（M4 起的做法） |
| 你的操作 | 编辑、Save、Ctrl+S、Discard changes、切换分节、离开 |

pi 每个目录只读第一个存在的 `AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD`；先读 agentDir 的一个，
再从文件系统根到工作目录逐级读（[v0 m6-checks.md](../../v0/m6-checks.md)）。不受项目信任控制。Mori 不截断任何一个文件，模型拿到的总是全文。

## 位置

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| Customize 的分节 | 跟随的会话 | 左侧分节列表第一节 `AGENTS.md`（`data-section="agents"`）：有会话时 `AGENTS.md`、`Built-in tools`、`Skills`、`MCP`、`Plugins`；没有会话时 `AGENTS.md`、`Skills`、`Plugins`（这一节不需要会话） | 切换分节（点、Tab、↑ ↓，同 v0） |
| 进入 Customize | 你点了侧栏 `Customize`，或记忆页 `AGENT` 的 `Edit in Customize` | 落在 `AGENTS.md`；操作记录 `Open Customize`（从记忆页来时 `Open Customize → AGENTS.md`） | — |
| 已经在 Customize 时点侧栏 `Customize` | — | 什么都不变：不问、不重新读、留在当前分节（同记忆页的 `Memory`） | — |
| 和 `tools.get` 无关 | — | 这一节不等 `tools.get`，不显示它的 `Loading…` 与读取失败（那是另外四节的）；`tools.get` 失败时这一节照常可用 | — |
| 顶部 | 同 v0 tools.md | `Back to app`、`Customize`、跟随的会话；没有会话时 `No open session. Only AGENTS.md and user-level skills and plugins are listed.`（2026-10-26 改，临时，走查时可以改）；下面一行 `Changes apply to new sessions. Sessions already open aren’t affected.` 与 `New session` | 同 v0 |
| 不信任 | 跟随的会话的项目没有被信任 | 顶部仍有 `This workspace isn’t trusted, so its skills and settings aren’t listed`（说的是技能与设置）；这一节照常列出项目加载的文件 | — |
| 设置页 | — | 只有 `Models`、`UI issues` 两节，没有 `AGENTS.md`（2026-10-26 改） | — |

## 用户级

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 读取中 | `agents.get` 还没返回 | 标题 `AGENTS.md`，`User` 下面 `Loading…`，编辑框不可用 | — |
| 读取失败 | `agents.get` 报错（第一次读） | `Couldn’t load AGENTS.md: <原文>`，没有编辑框 | 换到另一节再回来 |
| 重新读取失败 | 已经读到过，之后的 `agents.get`（保存后、跟随的会话换了）报错 | 同一句原文显示在这一节顶部，下面仍是读到过的内容和编辑框（2026-10-26 改：原来只记日志） | 换到另一节再回来 |
| 文件不存在 | `content` 为 null | 路径 `<agentDir>\AGENTS.md`；`This file doesn’t exist yet. Saving creates it.`；空编辑框 | 编辑、Save |
| 已有文件 | `content` | 路径；编辑框里是文件内容 | 编辑 |
| 生效的是这个文件 | `effectivePath` 就是 `<agentDir>\AGENTS.md` | `In effect: <路径>`（`agents-effective`），后面单独一个元素 `<n> tokens`（`agents-tokens`） | Open in default app |
| 被 AGENTS.override.md 盖住 | `effectivePath` 是 `AGENTS.override.md` | 警示色 `<路径> takes precedence, so what you write here has no effect.`，后面 token 数 | Open in default app |
| 现在生效的是 CLAUDE.md | 还没有 `AGENTS.md`，`effectivePath` 是 `CLAUDE.md` / `CLAUDE.MD` | 警示色 `<路径> is in effect now. After you save, this AGENTS.md is loaded instead.`，后面 token 数；保存后变成 `In effect: <agentDir>\AGENTS.md` | Open in default app（可以先把内容抄过来） |
| 没有生效的文件 | `effectivePath` 为 null | 没有生效文件那一行，也没有 `agents-tokens` | — |
| 有未保存的改动 | 你改了编辑框 | `Save` 可用，旁边 `Unsaved changes` | Save（Ctrl+S 也可以）；Discard changes（回到读到的内容） |
| 保存中 / 已保存 / 保存失败 | `agents.save` | `Saving…`、`Saved · Applies to new sessions`、`Couldn’t save: <原文>`（保留你写的字）；保存后重新 `agents.get` | — |
| 跟随的会话换了 | 你在侧栏归档、删除了跟随的会话，重启后台进程后会话重新打开 | 重新 `agents.get`（带新的会话），编辑框里没保存的字和 `Unsaved changes` 都还在（2026-10-26 改） | 同上 |

说明一行 `Every session reads this file. Changes apply to new sessions only; sessions already open don’t change.` 不变。

## 项目加载的文件（只列出）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 有跟随的会话 | `agents.get { sessionId: 跟随的会话 }` 的 `loaded` | 标题 `Files loaded by <项目名>`；说明 `Read when the session opens. If you change a file later, only new sessions pick it up. Project files can’t be edited here.`；每个文件一行完整路径（`.agents-path`）和单独一个元素 `<n> tokens`（`.agents-tokens`）；没有时 `This project doesn’t load an AGENTS.md or CLAUDE.md` | 每行 Open in default app |
| 跟随的会话还在打开中，或换了会话还没读到 | 跟随的会话没有 pi 会话 id，或最近读到的结果不是这个会话的 | 标题 `Files loaded by <项目名>`，下面 `Loading…`（2026-10-26 加，临时，走查时可以改）；会话打开好后重新读取 | — |
| 没有跟随的会话 | 没有打开的会话，或它打开失败 | 标题 `Files loaded by the project`，说明 `Open a session to see which files its project loads.` | — |

## token 数与提醒线（规格 §10.3）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| token 数 | `userTokens`、`loaded[].tokens` | `<n> tokens`（1 时 `1 token`），1000 起按千分位写（`2,099 tokens`，2026-10-26 改，同模型行的数字） | — |
| 超出 | `total` > 2000（`total` = `userTokens` + `loaded` 的 token 之和，没有会话时为 `userTokens`；看的是全部加载的文件的合计，不是每个文件） | 警告色 `Over 2,000 tokens. Mori doesn’t shorten AGENTS.md; edit the files to keep prompts short.`（`agents-over`，同记忆页 `AGENT` 的文字；2026-10-26 改：原来是 500） | 编辑文件 |
| 没有超出 | `total` ≤ 2000 | 没有 `agents-over` | — |

token 用 `estimateMemoryTokens`，每个文件单独算（中日韩字符每个 1，其余 ÷ 4 向上取整）。超出只是提醒：不截断、不拒绝保存，模型照样拿到全文。
跟随的会话换了、新的结果还没读到时不显示 `agents-over`（不拿上一个会话的合计提醒；会话还在打开中时按只读到的用户级判断）。

## 离开时有未保存的改动

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 离开时有未保存的改动 | 你点了 `Back to app`、换到 Customize 的另一节（点或 ↑ ↓，2026-10-26 改：原来 Customize 换分节不问）、点了侧栏的会话 / `New session` / `Open folder…` / `Memory` / `Settings`、按 Ctrl+N、F8 报告框的 `View in Settings` | 确认框 `Discard changes to AGENTS.md?`，说明 `Your edits haven’t been saved. Leaving now discards them.`；按钮 `Discard` 和 `Keep editing`，焦点在 `Keep editing`，Esc 等于 `Keep editing` | Discard（编辑框回到读到的内容，照常离开；离开没有发生时，例如取消了选文件夹，留在这里，没有未保存的改动）；Keep editing（留在这里，什么都不变：点的已归档会话不恢复，焦点回到编辑框） |
| 点当前分节 | 你点了已经选中的 `AGENTS.md` | 不问，什么都不变 | — |
| 把会话拖到 Customize 上 | 中栏是 Customize 时不能放下（同设置页，v0 split.md） | 不离开、不问，改动还在 | — |
| 关闭 Mori 窗口 | — | 不问（交付说明列出，同 v0） | — |

## 记忆页的 `AGENT`

`Edit in Settings` 改为 `Edit in Customize`（2026-10-26 改）：有未保存的编辑时先问，然后打开 Customize，落在 `AGENTS.md`。合计一行改为 `<total> / 2,000 tokens`，
超出时同上面的警告（[memory-page.md](memory-page.md)“AGENT”）。

## 反例

- 设置页没有 `AGENTS.md` 一节，`settings-nav` 里没有 `button[data-section="agents"]`。
- `tools.get` 读取失败时 `AGENTS.md` 仍能编辑、保存。
- 合计超过 2000 时不截断任何文件，保存照常；没有按每个文件的提醒。
- 项目的文件不能在 Mori 里编辑；写进 AGENTS.md 的要求只对之后新建的会话生效，已经打开的会话不变（界面明说）。
- 已经在 Customize 时点侧栏 `Customize` 不弹确认框。
- `agents-effective`、`.agents-path` 的文字里不带 token 数（token 数在单独的元素里）。

## 本表定下的界面细节

规格与负责人的话没给、本表定的（临时，走查时可以改）：没有会话时顶部 `No open session. Only AGENTS.md and user-level skills and plugins are listed.`；
跟随的会话还在打开中时项目一栏的 `Loading…`；重新读取失败时在顶部显示原文；token 数 1000 起按千分位写；从记忆页进来时的操作记录 `Open Customize → AGENTS.md`。
按推荐定下的（负责人没单独回答，见 WP-07.md）：分节名 `AGENTS.md`（不叫 Claude 的 “Instructions”）、放在第一节、提醒看全部加载的文件的合计。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 分节 | `[data-testid="tools-nav"] button[data-section="agents"]` |
| 这一节 | `data-testid="agents-section"`（2026-10-26 改：原来是设置页的 `.settings-section[data-section="agents"]`） |
| 用户级 | 编辑框 `agents-editor`；生效的文件 `agents-effective`；它的 token 数 `agents-tokens`；`.agents-user`、`.agents-path`、`.agents-status`、`.agents-line` 沿用 |
| 项目级 | `agents-loaded`；每个文件的 `.agents-path`、`.agents-tokens` |
| 超出 | `agents-over` |
| 离开确认 | `leave-dialog`（沿用 v0） |
