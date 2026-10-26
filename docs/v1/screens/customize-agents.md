# Customize › Agents

依据：[Customize › Agents 规格](../../specs/customize-agents.md)（下称“规格”）§4–§6；角色文件的格式与校验见
[TaskBoard 规格](../../specs/parallel-agents-taskboard.md) §4。补充 [v0 tools.md](../../v0/screens/tools.md) 的外框（顶部、跟随的会话、
“Changes apply to new sessions”与 New session）。标了“（临时，走查时可以改）”的文字登记在 [../defaults.md](../defaults.md)“Customize › Agents”。

## 来源

| 来源 | 内容 |
| --- | --- |
| `roles.get { sessionId }`（每次进入这一节、每次保存或删除之后） | `RolesInfo`：项目根、`.mori/agents` 的路径、会话的模型范围 `pick`、三项职责的持有者、全部问题行、agent 列表（第一个是 Mori）、表单可选的模型范围与工具 |
| `roles.save { sessionId, file, agent }` 的结果 | 新的 `RolesInfo` 与写出的文件，或 `error`（问题行，每条一行） |
| `roles.delete { sessionId, file }` 的结果 | 新的 `RolesInfo`，或 `error` |
| 跟随的会话 | 同 tools.md：当前会话（分屏时焦点所在的那一栏）；没有会话时这一节不出现 |
| 你的操作 | 点行、New agent、Edit、Open in default app、Delete…；模型菜单里的 Manage agents |

## 分节与列表

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 分节 | 有跟随的会话 | 左边分节列表里 “Agents”（`data-section="roles"`），在 “Skills” 之后；没有会话时不出现 | 切换到这一节 |
| 读取中 | `roles.get` 还没返回 | `Loading…` | — |
| 读取失败 | `roles.get` 返回 `error`（目录读不出） | `Couldn’t load agents: <原文>` 和 “Retry” | Retry |
| 标题 | — | `Agents`；一行说明 `Agents Mori can hand work to in Task mode. They’re files in this project’s .mori/agents folder.`（临时）；右边 “New agent” | New agent |
| Mori | `agents[0]`（基座） | 第一行：`Mori`、标记 `Built-in`、`General-purpose agent with the default tools`、它持有的职责（没人认领的那几项，例如 `Talks to you · Plans requests · Closes requests`）、模型的一句话（下面“模型的一句话”） | 展开 |
| 项目的 agent | `agents[1…]`，按文件名 | 每个一行：名字、标记 `Project`、说明的第一行、职责（没有时不显示）、模型的一句话 | 展开 |
| 没有文件 | `agents` 只有 Mori | Mori 的行下面 `No agents in this project yet. Mori does everything in Task mode until you add one.`（临时） | New agent |
| 有问题的文件 | `problems` 不为空 | 列表上方警示色 `New sessions in this project won’t start until these agent files are fixed.`；那个文件的行：名字（frontmatter 的 name 或文件名）、标记 `Project`、`Can’t be used`、它的问题行（每条一行，与 “Fix the agent files” 卡上相同）；其他合格的文件照常 | 展开（只有问题与 File） |
| 刚保存 | `roles.save` 成功 | 表单收起；那一行展开，下面 `Saved · Applies to new sessions` | — |

### 模型的一句话

| 状态 | 来源 | 必须可见 |
| --- | --- | --- |
| 都能用 | `candidates` 的 `reason` 都为 null | `Models: <第一个模型的 id>`，多于一个时 `Models: <id> and <n> more` |
| 部分不能用 | 有 `reason` 不为 null | 警示色 `<k> of <n> models can’t run` |
| 都不能用 | 全部不为 null | 警示色 `No model can run this agent` |
| 没有候选 | `candidates` 为空（会话没有模型范围，且这个 agent 没写 models） | `No model range picked` |

## 展开

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| Models：用会话的范围 | Mori，或没写 `models` | `Same as the session’s model range (<pick>)`；没有范围时 `The session has no model range.` | — |
| Models：写了的 | `models` 不为 null | `Tries these in order:` | — |
| 每个候选 | `candidates[]` | 一行：模型全名，`Ready`，或警示色的原因原文（`tool calling not verified yet`、`verifying…`、`handoff tier C is below B`、`effective window 32768 < 65536` 等，与模型菜单、拒绝启动卡相同） | — |
| Model needs | `needs` 不为空 | 每项的白话（规格 §6.3）；有 `protocol_write` 一类时下面一行 handoff tier 的说明 | — |
| Tools | `tools` | 写了的：`read, grep, bash`（`mcp__*` 写作 `all MCP tools`）；没写的：`Same as Mori: read, bash, edit, write, and all MCP tools`（按 `baseTools`） | — |
| Other settings | `differFromAuthor`、`subscribe` | 只在有时：`Avoids the model family that changed the code`；`Woken when a request closes (<过滤>)` | — |
| Prompt | `body` | 正文，等宽、保留换行；为空时 `No prompt` | — |
| File | `file`、`path` | 相对路径，例如 `.mori/agents/reviewer.md`；Mori 没有这一块 | Edit（有问题的文件没有）；Open in default app；Delete… |
| 打开失败 | 主进程 `openPath` 的错误 | `Couldn’t open this file with the default app: <原文>` | — |

## 表单（New agent / Edit）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 新建 | 你点了 “New agent” | 列表上方一张表单（`data-mode="new"`）：Name、Description（`n/200`）、Jobs、Models、Tools、Prompt，各自的说明一行（规格 §6.4）；默认：没有职责、`Same as the session’s model range`、`Same as Mori`、正文空 | Save；Cancel |
| 编辑 | 你点了一个文件的 “Edit” | 同上（`data-mode="edit"`），预填文件现在的值；Name 的说明改为 `The file name stays <file>.` | Save；Cancel |
| 文件头有注释 | `headerComments` 为真 | 表单上方 `Saving rewrites this file’s header and removes its comments.` | — |
| Jobs 被别人认领 | `holders` 里这一项是另一个文件的 agent | 那个勾选框不可用，旁边 `<name> does this` | — |
| 选模型 | 你选了 `Use these, in order` | 有序列表（拖动排序，同 Settings › Models）、每项的移除按钮、`Add model range` 下拉（Groups / Providers / Models，文字同模型菜单） | 添加；移除；拖动 |
| 选工具 | 你选了 `Only these` | 8 个 pi 工具与 `All MCP tools` 的勾选框 | 勾选 |
| 不能保存 | Name 或 Description 为空、`Use these, in order` 的列表为空、`Only these` 一个都没勾 | Save 不可用 | — |
| 保存中 | `roles.save` 还没返回 | Save 变为 `Saving…`，表单不可改 | — |
| 保存失败 | `roles.save` 返回 `error` | 表单保留你写的；下面 `Couldn’t save:` 和问题行（每条一行），例如 `name "reviewer" is already used by .mori/agents/rev.md`、`A file named .mori/agents/reviewer.md already exists.`、`This agent file no longer exists.` | 改后再存 |
| 有改动时离开 | 换分节、Back to app、打开别的表单、点侧栏的会话 | 确认框 `Discard this agent?` / `Your edits haven’t been saved. Leaving now discards them.`（同 AGENTS.md 编辑器的离开确认） | Discard；Keep editing |

## 删除

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 确认 | 你点了 “Delete…” | 确认框 `Delete agent “<name>”?`，说明 `<file> will be permanently deleted. This can’t be undone. Sessions already open aren’t affected.` | Delete；Cancel |
| 删除中 | `roles.delete` 还没返回 | 按钮 `Deleting…` | — |
| 已删除 | 成功 | 确认框关上，这一行不在了 | — |
| 删除失败 | `roles.delete` 返回 `error` | 确认框里 `Couldn’t delete: <原文>` | 再试；Cancel |

## 模型菜单的 Manage agents

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 菜单打开 | WP-09 之后的模型菜单 | Task mode 那一行下面 `Manage agents`（`data-action="manage-agents"`）；Task mode 开、关时都有 | 点：关菜单，打开 Customize 并选中 Agents |
| Task mode 打开 | `pickLocked` | 模型那一节变灰、悬停 `Task mode picks the model for each agent`（WP-09）；`Manage agents` 照常可用 | 同上 |

## 反例

- 保存、删除之后已经打开的会话不变（`TeamState.roles` 不变）；只有新会话、或被拒绝启动的会话点 “Check again” 后用上。
- 这一节不显示 “Connected”、限流等此刻的状态：`Ready` 只表示静态检查通过。
- 写出的文件不带 Mori 的标记：手写的和这里写的文件对会话没有区别。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 分节 | `button[data-section="roles"]`；内容 `data-testid="agents-page"` |
| 行 | `[data-testid="agent-row"][data-name]`，`data-scope`（`builtin` / `project`），`data-valid`（`true` / `false`），`aria-expanded` |
| 一句话 | `data-testid="agent-models"`，`data-state`（`ready` / `some` / `none` / `empty`） |
| 候选 | `[data-testid="agent-candidate"][data-ref]`，`data-ready` |
| 问题 | `data-testid="agent-problem"`；列表上方的警示 `data-testid="agents-invalid"` |
| 表单 | `data-testid="agent-form"`，`data-mode`；保存的错误 `data-testid="agent-form-error"` |
| 菜单项 | `[data-action="manage-agents"]` |
