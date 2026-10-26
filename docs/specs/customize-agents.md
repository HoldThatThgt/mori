# Customize › Agents 构建规格

状态：构建规格，负责人 2026-10-26 批准（连同状态表 [v1/screens/customize-agents.md](../v1/screens/customize-agents.md)）；§0“已定的”四条是负责人的回答。更新日期：2026-10-26。

依据：2026-10-26 负责人走查 M20（"I can't find team mode setup panel, where can I setup model for each role and add extra agent?"，
[walkthrough-1026-checks.md](../v1/walkthrough-1026-checks.md)）。今天唯一的办法是手写 `<project>/.mori/agents/*.md`；
[平行 Agent 与 TaskBoard 规格](parallel-agents-taskboard.md)（下称“TaskBoard 规格”）§3 写的是“你写；Mori 只读”，本文改这一条（§3）。
在 [app-v0](../app-v0.md) §6“后台进程只做八件事”里属于第 7 件（平行 Agent 与 TaskBoard）。状态表在
[v1/screens/customize-agents.md](../v1/screens/customize-agents.md)，临时默认值在 [v1/defaults.md](../v1/defaults.md)“Customize › Agents”一节，
检查记录写在 `docs/v1/walkthrough-1026/customize-agents.md`。

本文扩展 TaskBoard 规格，不改角色文件的格式、校验、读取时机和角色怎么选模型（TaskBoard 规格 §4、§12）：界面读的、写的都是同一种文件，
写出的文件由同一套校验（`roles.ts`）判定，所以手写的文件和在这里写的文件对会话没有区别。

基线：本分支从 `app-v0` 开出，开工前合入走查的 WP-02（精简模型卡：不再显示 Handoff tier）、WP-07（Customize › Instructions，AGENTS.md 编辑器）、
WP-08（Customize 的内置工具开关）、WP-09（模型菜单里的 Task mode）。本文的界面文字按 WP-09 之后的叫法写 “Task mode”。

## 0. 范围

**做**：

- Customize 页新的一节 “Agents”：列出基座 Mori 和这个项目的 agent 文件，每个 agent 的说明、职责（三项权限）、工具、要求，
  以及它会按顺序用的模型、每个模型能不能用、不能用的原因（例如 `handoff tier C is below B`）（§4、§6.2、§6.3）；
- 有问题的文件逐条列出问题，文字与拒绝启动卡相同（§4.3）；
- “New agent” 表单与 “Edit”：名字、说明、职责、模型（从 Settings › Models 里选）、工具、说明正文，写出
  `<project>/.mori/agents/<name>.md`（§5、§6.4）；
- 文件的 “Open in default app” 与 “Delete…”（§5.4、§6.5）；
- 模型菜单里 Task mode 那一行下面的 “Manage agents”，打开这一节（§6.6）；
- 进程桥命令 `roles.get`、`roles.save`、`roles.delete`（§4、§5），F8 的操作记录（§5.6）。

**不做**：

- 用户级的 agent（Claude 有 `~/.claude/agents`；Mori 只读项目的 `.mori/agents`，TaskBoard 规格 §4.1）；
- 在表单里写 `requires`、`differ_from`、`subscribe`：列表里用白话显示，编辑时原样保留（§5.3），要改时打开文件改；
- 给基座 Mori 设模型：它用会话的模型范围（TaskBoard 规格 §4.2），这一节只说明这一点；
- 让已经打开的会话立即用上改动：角色在会话打开时读一次（TaskBoard 规格 §4.3），与 Customize 其他各节一样只对新会话生效；
- `TeamState.roles` 不扩展：它是会话打开时读到的角色，随每个 `mori.team_state` 事件发出；这一节每次进入都从文件重新读（§4）。

**已定的**（负责人 2026-10-26 回答；括号里是当时的选项）：

1. 名字：**新的一节叫 “Agents”，AGENTS.md 编辑器那一节（WP-07）叫 “Instructions”**（推荐的是 “Agents” + “AGENTS.md”；另一个选项 “Task mode agents”）。
   正文里文件仍写 AGENTS.md。因为 “Instructions” 成了分节名，agent 的正文在这里叫 “Prompt”（Claude 的 “Agent prompt”，§1）。
2. **已有的文件可以用同一张表单 “Edit”**：保存时重写文件头，表单没有的字段原样保留（§5.3）（另一个选项：只有 New agent）。
3. **表单里有 “Jobs”** 的三个勾选框（Talks to you、Plans requests、Closes requests），可以建一个负责拆分的 planner（另一个选项：只做 task）。
4. **“Manage agents” 在模型菜单里一直显示**（Task mode 开或关）（另一个选项：只在 Task mode 打开时）。

## 1. 术语与界面名

| 本文与代码 | 界面 | 说明 |
| --- | --- | --- |
| role，`RoleDef`（TaskBoard 规格 §1） | agent / Agents | 界面上一律叫 agent（批准卡说明 “Applies to all agents in this session.” 已经这样叫）；代码名不变，命令叫 `roles.*`，因为 `agents.get`、`agents.save` 已经是 AGENTS.md 编辑器的命令 |
| 基座 `mori` | Mori，标记 `Built-in` | 没有文件 |
| 角色文件 | agent file；标记 `Project` | `.mori/agents/*.md` |
| seat：`dialog` / `create` / `close` | Jobs：`Talks to you` / `Plans requests` / `Closes requests` | 临时文字（§7）；行上用 “ · ” 连起来 |
| `models` | Models | 有序的模型范围（分组、提供商或 `<provider>/<model>`） |
| `tools` | Tools | pi 的工具名照写（与 Built-in tools 一节相同） |
| `requires` | Model needs | 白话写法见 §6.3 |
| 候选能用 | Ready | 只是静态校验（TaskBoard 规格 §12.2 的第 1、3 步）通过；限流、断线在运行时才知道 |
| 写入等级 A / B / C | handoff tier | 模型卡上不再显示（WP-02），只在这里需要时解释（§6.3） |
| 正文（`body`） | Prompt | Claude 的 “Agent prompt”；不叫 Instructions，免得与分节名相同 |
| AGENTS.md 编辑器（WP-07） | Instructions（Customize 的分节名；正文里文件照写 AGENTS.md） | 每个会话都读的说明文件；负责人 2026-10-26 定（§0 第 1 条）。与 “Agents” 不相邻 |

## 2. 组件与代码落点

| 组件 | 文件 | 做什么 |
| --- | --- | --- |
| 检查与写法 | `kernel/roles.ts`（改） | 导出逐个文件的检查 `inspectRoleFiles`（复用 `checkFile` 与跨文件检查，结果按文件，不像 `parseRoleFiles` 有问题就只剩基座） |
| 文件的写法 | `kernel/roleFiles.ts`（新，纯函数） | 把表单的字段与要保留的字段写成文件全文（§5.1）；文件名与路径的检查（§5.2） |
| 命令 | `kernel/roleCommands.ts`（新） | `roles.get`、`roles.save`、`roles.delete`：读写 `.mori/agents`，用模型层算候选与原因（§4、§5） |
| 选择器 | `kernel/selector.ts`（改） | 导出一个候选的第 1、3 步排除（现在的 `staticExclusion`），给 `roles.get` 逐个模型判断 |
| 进程桥 | `shared/roles.ts`（新）、`shared/protocol.ts`（改） | `RolesInfo`、`AgentView`、命令的 zod 定义；职责与要求的界面文字 |
| 界面 | `renderer/src/components/ToolsAgents.tsx`、`ToolsAgentForm.tsx`（新）；`ToolsPage.tsx`、`ModelMenu.tsx`、`state/tools.ts`（分节键）（改）；`state/roles.ts`（新） | §6 |

## 3. 数据文件（改 TaskBoard 规格 §3）

| 文件 | 内容 | 谁写 |
| --- | --- | --- |
| `<project>/.mori/agents/*.md` | 角色定义（TaskBoard 规格 §4） | 你：手写，或在 Customize › Agents 里新建、编辑、删除（本文 §5）；会话只读 |

- 后台进程只在 `roles.save`、`roles.delete` 里写这个目录，别处仍然只读；写入先写临时文件再改名（`writeFileAtomic`）。
- 写出的文件就是一个普通的角色文件：会话打开时按 TaskBoard 规格 §4.3、§4.4 读和校验，与手写的没有区别。
- 表单 Tools 的 `All MCP tools` 写 `mcp__*`（全部 MCP 工具，同基座的白名单写法）。TaskBoard 规格 §4.1 原来只认
  `mcp__<服务>__…`，2026-10-26 为这个勾选框加上 `mcp__*`（临时，§7；另两个做法：表单不提供 All MCP tools，或按此刻的
  MCP 服务各写一个 `mcp__<服务>__*`，等负责人定）。

## 4. 读：`roles.get`

### 4.1 命令与结果

`roles.get { sessionId }`（只读）：读跟随的会话所在项目的 `.mori/agents/*.md`（与 `loadRoles` 同样只读这一层、按文件名排序），每次进入这一节、
每次保存或删除之后读一次；不监视文件。结果 `{ info: RolesInfo, error: null }`；目录读不出时 `{ info: null, error: <原文> }`（§4.3）。`RolesInfo`：

```ts
interface RolesInfo {
  cwd: string                 // 项目根（跟随的会话的工作目录）
  dir: string                 // <cwd>\.mori\agents 的绝对路径（目录不存在也给出）
  pick: string | null         // 会话的模型范围（你最后选的；Task mode 下不能改，仍是这个）
  holders: TeamHolders        // 三项权限的持有者：合格的文件认领的，其余是 mori（有问题的文件不参与）
  problems: string[]          // 全部问题行（TaskBoard 规格 §4.4 的写法 <file>: …）；不为空时新会话会按 agents_invalid 拒绝启动
  agents: AgentView[]         // 第一个是基座 mori，后面是文件，按文件名
  ranges: { pick: string; kind: 'group' | 'provider' | 'model'; label: string }[]  // 表单可选的模型范围，顺序同模型菜单
  piTools: string[]           // 表单可选的 pi 工具：roles.ts 的 PI_TOOL_NAMES（read、bash、edit、write、grep、find、ls、powershell）
  baseTools: string[]         // 新会话会用的默认工具；基座与“Same as Mori”用
}
```

`baseTools` 照 `sessions.ts` 开会话时的取法（`settings.getDefaultTools() ?? PI_DEFAULT_TOOLS`），但每次 `roles.get` 都按这个项目
重新读用户级与项目的 pi 设置，不用会话打开时的那份：Customize › Built-in tools 的开关（WP-08，写用户级 `settings.json` 的
`defaultTools`）改了之后，这里跟着变，与“Changes apply to new sessions”一致。

```ts
interface AgentView {
  name: string                // 有问题的文件：frontmatter 里的 name 是字符串时用它，否则是文件名去掉 .md
  file: string | null         // 相对项目根，例如 .mori/agents/reviewer.md；基座为 null
  path: string | null         // 绝对路径；基座为 null
  description: string
  body: string                // 正文（Prompt）
  seats: Seat[]
  tools: string[] | null      // null：同基座
  models: string[] | null     // null：用会话的模型范围
  needs: string[]             // requires 里 tool_calling 以外的项，原文（§6.3 换成白话）
  differFromAuthor: boolean
  subscribe: Subscription[]
  candidates: { ref: string; reason: string | null }[]   // §4.2；reason 为 null 时 Ready
  problems: string[]          // 这个文件的问题行（含跨文件的）；不为空时只有 name、file、path、problems 有意义
  headerComments: boolean     // 文件头里有 # 注释（编辑保存会去掉它们，§5.3）
}
```

### 4.2 每个 agent 的候选与原因

- 候选的来源与会话里相同（TaskBoard 规格 §12.1）：`models` 依次展开、去重（`expandPicksIn`）；没写 `models` 的文件和基座用 `pick`
  展开；`pick` 为 null 时候选为空。
- 每个候选按选择器第 1、3 步判断（`staticBase` 加上这个 agent 的 `requires`），通过时 `reason` 为 null，否则是那一步的界面文字
  （`REASON_TEXTS`，与模型菜单、拒绝启动卡同一份）：例如 `not in your model settings`、`tool calling not verified yet`、
  `tool calling failed verification`、`verifying…`、`handoff tier C is below B`、`effective window 32768 < 65536`、
  `structured_output not verified`。
- 不判断第 4 步（限流、断线等此刻的可用性）和 `same_family`（要看具体 task 的作者，TaskBoard 规格 §12.9）；后者在 §6.3 用一句话说明。
- `models` 里不在你的模型设置里的名字已经是这个文件的问题（TaskBoard 规格 §4.4），`candidates` 只列存在的范围展开的模型。

### 4.3 有问题的文件

- 用 `inspectRoleFiles` 逐个文件检查：与会话打开时的启动校验同一套规则、同样的问题行（TaskBoard 规格 §4.4），所以这里列出的问题
  就是新会话的 “Fix the agent files” 卡上会列出的。
- 读不出文件（权限等）同启动校验：`<file>: can’t read the header: <原文>`。
- 目录读不出（不是“不存在”）时 `roles.get` 返回 `error`，界面显示原文与 “Retry”。

## 5. 写：`roles.save` 与 `roles.delete`

### 5.1 `roles.save`

`roles.save { sessionId, file: string | null, agent: { name, description, seats, tools, models, body } }`：

- `file` 为 null 是新建，写 `<cwd>/.mori/agents/<name>.md`；不为 null 是编辑这个文件（§5.3），文件名不变（改了名字也不改文件名）。
- `seats` 为 `Seat[]`；`tools`、`models` 为 null 时文件里不写这个字段（同基座 / 用会话的范围）；为列表时按顺序写，空列表不允许
  （表单不会发出，`models` 的空列表本来就是问题 `models must name at least one model range`）。
- 写出的全文：

```text
---
name: reviewer
description: "Reviews the change and runs the tests"
tools: [read, grep, bash]
models: [deepseek/deepseek-chat, fast]
seats: [close]
---

<正文，去掉首尾空行；为空时没有这一段>
```

- 字段顺序同 TaskBoard 规格 §4.1 的表：`name`、`description`、`tools`、`models`、`requires`、`seats`、`differ_from`、`subscribe`，
  没有的不写。`description` 总写成 JSON 字符串（YAML 认得，冒号、引号、`#` 都不用另外转义）；列表写成单行的 `[a, b]`，
  每项只含字母、数字和 `._/-` 与下划线时原样写，否则写成 JSON 字符串；`subscribe` 写成 JSON（YAML 的子集）。换行用 `\n`，UTF-8，不加 BOM。
  不新增依赖：写法只用 JSON，读回用 pi 的 `parseFrontmatter`。
- 结果 `{ info: RolesInfo, file: string, error: null }`；不写文件时 `{ info: null, file: null, error }`（§5.2 的问题，每条一行）。

### 5.2 校验：写之前用同一套规则

- 写之前把要写的全文和目录里其他文件一起交给 `inspectRoleFiles`：这个文件有任何问题（自己的，或与别的文件冲突的：名字重复、
  职责已被别的文件认领）就不写，`error` 为这些问题行冒号后面的文字，每条一行，例如 `name "reviewer" is already used by .mori/agents/rev.md`、
  `seat "close" is also claimed by .mori/agents/planner.md`、`description must be at most 200 characters`。
  别的文件自己的问题不挡这次保存（它们照常列在 `problems` 里）。
- 新建时 `<name>.md` 已经存在（不论是否合格）：`A file named .mori/agents/<name>.md already exists.`；名字不合规则时先报名字的问题，
  不拼文件名。
- 编辑时 `file` 必须是 `.mori/agents/` 下直接的一个 `.md` 文件，且现在存在；否则 `error` 为 `This agent file no longer exists.`
  （例如在别处删掉了）。路径一律由后台进程按 `cwd` 和文件名拼出，不接受绝对路径或 `..`。
- 读回检查：写出之后再用 `parseFrontmatter` 读一次，字段与要写的一致（单元测试覆盖，运行时不重复）。

### 5.3 编辑时保留的字段

- 编辑重写整个文件头：表单的六个字段按表单的值写；`requires`、`differ_from`、`subscribe` 取文件里现在的值原样写回（按 §5.1 的写法）。
- 文件头里的 `#` 注释不保留（JSON 写法写不出注释）；`headerComments` 为真时表单上方提示 `Saving rewrites this file’s header and removes its comments.`。
- 有问题的文件不能编辑（§6.3）：先 “Open in default app” 改好，或 “Delete…”。

### 5.4 `roles.delete`

`roles.delete { sessionId, file, name }`：`file` 的检查同 §5.2；删除这个文件（不进回收站，同删除会话），结果 `{ info: RolesInfo, error: null }`，失败时 `{ info: null, error: <原文> }`。`name` 是这个 agent 的名字，只用于操作记录（§5.6）。
文件已经不在时也算成功（列表本来就要更新）。

### 5.5 对已经打开的会话

不变：角色在会话打开时读一次（TaskBoard 规格 §4.3）。保存、删除之后：已经打开的会话照旧；新会话用新的文件；因为有问题而被拒绝启动的会话，
在卡上点 “Check again” 重新读。Customize 页顶部本来就写着 “Changes apply to new sessions. Sessions already open aren’t affected.” 和 “New session”。

### 5.6 操作记录

界面的操作记录（F8 的 “Recent activity”）：`roles.save` 记 `Save agent <name>`，`roles.delete` 记 `Delete agent <name>`；
“Manage agents” 记 `Open Customize → Agents`（同记忆页进入 Instructions 时的 `Open Customize → Instructions`）；`roles.get` 不记。

## 6. 界面

状态表见 [v1/screens/customize-agents.md](../v1/screens/customize-agents.md)，实现以状态表为准；下面是必须做到的行为和文字（临时文字见 §7）。

### 6.1 分节

- Customize 的分节加 “Agents”（`data-section="roles"`），排在 “Skills” 之后；只在有跟随的会话时出现（同 Built-in tools、MCP：agent 属于项目）。
  合入 WP-07 后的顺序：有会话时 Built-in tools、Skills、Agents、MCP、Plugins、Instructions；没有会话时 Skills、Plugins、
  Instructions。与 “Instructions”（`data-section="agents"`，AGENTS.md 编辑器）不相邻。
- 分节的键 `roles` 加进 `state/tools.ts` 的 `ToolsSection`；选中哪一节由 `useToolsNav` 管，“Manage agents” 用
  `openTools('Open Customize → Agents', 'roles')` 落在这一节。这一节同 Instructions 一样不读 `tools.get`：自己读 `roles.get`，
  `tools.get` 的 `Loading…` 与失败不挡它。
- 标题 `Agents`，下面一行 `Agents Mori can hand work to in Task mode. They’re files in this project’s .mori/agents folder.`，右边 “New agent”。

### 6.2 列表

- 每个 agent 一行（`data-testid="agent-row"`、`data-name`、`data-scope` 为 `builtin` / `project`、`data-valid`）：名字、标记 `Built-in` 或 `Project`、
  说明的第一行、职责（例如 `Plans requests · Closes requests`；没有时不显示），以及模型的一句话：
  - 全部候选 Ready：`Models: <第一个 Ready 的模型 id>`，多于一个时加 `and <n> more`；
  - 有不能用的：警示色 `<k> of <n> models can’t run`；全部不能用：`No model can run this agent`；
  - 候选为空（会话没有范围）：`No model range picked`。
- 基座 Mori 总在第一行；它的说明 `General-purpose agent with the default tools`。
- 没有文件时，Mori 的行下面：`No agents in this project yet. Mori does everything in Task mode until you add one.`
- `problems` 不为空时，列表上方警示色：`New sessions in this project won’t start until these agent files are fixed.`；
  有问题的文件那一行显示 `Can’t be used` 和它的问题行（每条一行）。

### 6.3 展开

点一行展开（再点收起，同 Skills 一节）：

| 块 | 内容 |
| --- | --- |
| Models | 基座和没写 `models` 的：`Same as the session’s model range (<pick>)`（没有范围时 `The session has no model range.`）；写了的：`Tries these in order:`。下面每个候选一行：模型全名，`Ready` 或原因（警示色）。候选为空时不列 |
| Model needs | 只在有 `needs` 时：每项的白话：`protocol_write` → `Fills in handoff forms (verified)`；`protocol_write>=B` → `Handoff tier B or better`；`structured_output` → `Structured output (verified)`；`vision` → `Image input`；`context>=N` → `Context window of at least N tokens`。有 `protocol_write` 一类时下面一行说明 `Handoff tier is how a model fills in the form it hands back at the end of a task: A, B, or C (weakest). Mori finds it when it checks the model.` |
| Tools | 写了的：工具名用 “, ” 连起来，`mcp__*` 写作 `all MCP tools`；没写的：`Same as Mori: <baseTools>, and all MCP tools` |
| Other settings | 只在有时：`differ_from` → `Avoids the model family that changed the code`；`subscribe` 每项 `Woken when a request closes`，有过滤时加 `(<过滤>)`，过滤写作 `has ruled-out approaches` / `no ruled-out approaches`、`outcome: done, failed` |
| Prompt | 正文（等宽、保留换行）；为空时 `No prompt` |
| File | 相对路径；操作 `Edit`（有问题的文件没有）、`Open in default app`、`Delete…` |

有问题的文件展开时只有问题行和 File 一块。

### 6.4 New agent 与 Edit 表单

在列表上方展开一张表单（`data-testid="agent-form"`、`data-mode` 为 `new` / `edit`），同一时刻只有一张；打开别的表单或换分节时收起
（有改动时离开先问：表单有改动时用 `state/leaveGuard.ts` 的 `setLeaveGuard` 登记检查，换分节、Back to app、点侧栏的会话
都经过它，同 Instructions 一节；写法同 AGENTS.md 编辑器的离开确认：标题 `Discard this agent?`，说明 `Your edits haven’t been saved. Leaving now discards them.`）。

| 字段 | 控件 | 说明（字段下面一行） |
| --- | --- | --- |
| Name | 文本框 | `Lowercase letters, digits, and -. The file is saved as .mori/agents/<name>.md.`（编辑时 `The file name stays <file>.`） |
| Description | 文本框（≤ 200 字符，显示 `n/200`） | `Other agents read this when they decide who does what.` |
| Jobs | 三个勾选框 `Talks to you`、`Plans requests`、`Closes requests` | `Leave all off for an agent that only works on tasks. Jobs no agent takes stay with Mori.`；被别的文件认领的那一项不可用，旁边写 `<name> does this` |
| Models | 单选 `Same as the session’s model range` / `Use these, in order`；选后者时一个有序列表与 `Add model range`（下拉：Groups、Providers、Models 三节，同模型菜单的顺序与文字） | 列表拖动排序：把一项拖到另一项上，它就排到那一项的位置（WP-03 还没合入，先用这一节自己的拖动列表。Mori 最后只留一份拖动排序的实现：WP-03 先合入时，这一节合入 app-v0 时改用它的组件；WP-03 只在 Settings › Models 里就地排序、没有可以共用的组件时，把这一节的列表挪成共用组件，两处都用它。另一份删掉；2026-10-26 走查会话定，集成时查），每项有移除按钮；列表为空时不能保存 |
| Tools | 单选 `Same as Mori` / `Only these`；选后者时 `piTools` 每个一个勾选框，再加 `All MCP tools` | 一个都不勾时不能保存 |
| Prompt | 多行文本框 | `What this agent does and how. Added to its system prompt.` |

- 按钮 `Save`（保存中 `Saving…`）、`Cancel`。保存成功：表单收起，列表重新读，新的或改过的那一行展开并显示 `Saved · Applies to new sessions`。
- 保存失败：表单保留你写的，下面 `Couldn’t save:` 加 §5.2 的问题（每条一行）；没有写文件。
- 编辑时预填文件现在的值；`headerComments` 为真时表单上方 §5.3 的提示。

### 6.5 Delete…

确认框：标题 `Delete agent “<name>”?`，说明 `<file> will be permanently deleted. This can’t be undone. Sessions already open aren’t affected.`，
按钮 `Delete`、`Cancel`；删除中两个按钮不可用，确认框里 `Deleting…`（同 MCP 的 `Removing…`）。删除失败：`Couldn’t delete: <原文>`。

### 6.6 模型菜单的 Manage agents

- WP-09 之后模型菜单里有 Task mode 那一行；它下面加一项 `Manage agents`（`data-action="manage-agents"`），Task mode 开和关时都显示。
  与 `Manage models` 一样只是跳到另一页，不加 “…”。
- 点了：关掉菜单，打开 Customize 并选中 Agents 一节（跟随的就是这个会话）。
- Task mode 下模型那一节变灰、悬停 `Task mode picks the model for each agent`（WP-09），这一项就在旁边，可以直接去看每个 agent 用哪个模型。

## 7. 临时默认值

登记在 [v1/defaults.md](../v1/defaults.md)“Customize › Agents”一节：

| 项 | 值 |
| --- | --- |
| 三项职责的界面文字 | `Talks to you`、`Plans requests`、`Closes requests` |
| 候选能用的文字 | `Ready` |
| 要求的白话 | §6.3 Model needs 一行 |
| 分节位置 | Skills 之后 |
| 新文件的字段写法 | §5.1：`description` 写 JSON 字符串，列表单行，`subscribe` 写 JSON |
| 编辑时文件名 | 不随名字改 |
| 删除 | 直接删除，不进回收站 |
| All MCP tools 的写法 | `mcp__*`（TaskBoard 规格 §4.1 为它放开，§3） |
| 本节的说明与空状态文字 | §6.1、§6.2 |

## 8. 要改的文件

| 文件 | 改什么 |
| --- | --- |
| `docs/specs/parallel-agents-taskboard.md` | §3 角色文件一行的“谁写”；§4.3 注明 Customize › Agents 的改动同样只对新会话生效（本文 §5.5） |
| `docs/v1/screens/customize-agents.md` | 新建状态表 |
| `docs/v0/screens/tools.md` | 外框的分节一行加 “Agents”，指向新状态表 |
| `docs/v1/screens/customize-agents-md.md` | “Customize 的分节”一行的列表加上 “Agents”（WP-07 的状态表） |
| `docs/v1/screens/model-menu.md` | Task mode 一行下面的 “Manage agents” |
| `docs/v0/ui-strings.md` | 术语表与 Customize 页的固定说法（§1、§6） |
| `docs/v1/defaults.md` | 新的一节（§7） |
| `AGENTS.md` | 仓库结构里加本规格；常用命令加 `npm run test:ag-unit` 与 `npm run test:agents`，并把 `test:agents` 列进“只在推送到远端之前跑”的那句 |
| `app/src/kernel/` | `roles.ts`、`selector.ts`（改），`roleFiles.ts`、`roleCommands.ts`（新），`commands.ts`（接命令） |
| `app/src/shared/` | `roles.ts`（新）、`protocol.ts` |
| `app/src/renderer/` | `ToolsAgents.tsx`、`ToolsAgentForm.tsx`、`state/roles.ts`（新）；`ToolsPage.tsx`、`state/tools.ts`、`ModelMenu.tsx`、`actionLog.ts`、样式 |
| `app/tests/` | §9；`spec-coverage.mjs` 加 `--spec agents` |
| `app/package.json` | 脚本 `test:ag-unit`、`test:agents` |

## 9. 验收

### 9.1 测试分层

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 单元 | `tests/unit/agents/*.test.mjs`（`node --test`，同 TaskBoard 的打包方式） | 写法与读回、逐个文件的检查、路径检查、候选与原因、白话文字 |
| App | `tests/ui/ag-app.mjs` | Electron + 合成端点；项目与 `.mori/agents` 由测试写好（照 §5.1 的写法给值加引号；`tb-helpers` 的 `writeRole` 不给 description 加引号，说明里有冒号时文件头会坏），模型配置与档案按 `v1-switch-helpers.seedUserData`（synthetic，不跑探针）；端口 4960–4969（2026-10-26 与走查会话约定，其他套件不用） |
| 回放、真实模型 | 不做 | 这一节不改发给模型的文字、工具、批准或会话事件：写出的是 TaskBoard 规格早就支持的角色文件，角色进会话的路径由 TB-01、TB-02、TB-38 覆盖（AGENTS.md 完成顺序第 2 条：只改界面与文件时可以跳过，检查记录写明） |

什么时候跑什么，按 AGENTS.md“测试分层”（2026-10-26 改）：

- 每一步：`npm run check`、构建、`npm run test:ag-unit` 与 `npm run test:unit`（改了 `roles.ts` 或 `selector.ts` 时再加
  `npm run test:tb-unit`），然后 `npm run test:quick`，再用 `node tests/ui/ag-app.mjs --only <编号,…>` 只跑这一步新增或改写的
  用例。不跑整个 `ag-app`，不跑 `tb-app-roles`、`m6-app-tools` 等整套，不跑覆盖检查。`ag-app.mjs` 因此要支持 `--only`
  （按编号选用例，结果写到 `ag-partial-app.json`，覆盖检查不认它）。
- 推送到远端之前（负责人要求时）：完整回归里加上整个 `ag-app`、AG-11 的现有套件与 `spec-coverage --spec agents`，
  即 `npm run test:agents`。
- 每次界面套件运行前后照约定告诉走查会话（端口 4960–4969）。

### 9.2 验收条目

每条测试的名字以条目编号开头。

| 编号 | 条目 | 通过条件 | 层 |
| --- | --- | --- | --- |
| AG-01 | 分节与列表 | 有跟随的会话时 Customize 有 “Agents”（在 Skills 之后），没有时没有；Mori 是第一行、标 `Built-in`、职责是没人认领的那几项；文件按文件名、标 `Project`、显示说明与职责；没有文件时的空状态文字 | App |
| AG-02 | 候选与原因 | 写了 `models` 的按顺序展开去重；没写的与 Mori 用会话的范围；每个候选 `Ready` 或选择器的原文：`tool calling not verified yet`、`requires: [protocol_write>=B]` 且等级 C 时 `handoff tier C is below B`、`context>=N` 时 `effective window …`；一句话的三种写法；会话没有范围时 `No model range picked` | 单元、App |
| AG-03 | 有问题的文件 | TaskBoard 规格 §4.4 的问题在这里显示同样的行；列表上方的警示；有问题的文件没有 Edit，有 Open in default app 与 Delete…；其他合格的文件照常列出 | 单元、App |
| AG-04 | 新建 | 表单的六个字段；保存写出 §5.1 的文件，`loadRoles` 读回的字段与表单一致；之后新建的会话的 `TeamState.roles` 有它；已经打开的会话的 `TeamState.roles` 不变 | 单元、App |
| AG-05 | 保存的校验 | 名字不合规则、为 `mori`、像编号、与别的文件重名、`<name>.md` 已存在、说明为空或超过 200 字符、职责已被别的文件认领：都不写文件，显示对应的问题；别的文件有问题不挡保存；`file` 带 `..` 或不在目录里被拒绝 | 单元、App |
| AG-06 | 编辑 | 预填现在的值；保存后文件名不变，`requires`、`differ_from`、`subscribe` 原样保留；文件头有注释时显示提示；文件在别处删掉后保存得到 `This agent file no longer exists.` | 单元、App |
| AG-07 | 删除 | 确认框的文字；Cancel 不删；Delete 删掉文件、列表更新；文件已经不在也算成功 | 单元、App |
| AG-08 | Manage agents | 模型菜单 Task mode 那一行下面有 `Manage agents`（Task mode 开、关都有）；点后打开 Customize 并选中 Agents，跟随这个会话 | App |
| AG-09 | 展开的内容 | §6.3 每一块：两种 Models 写法、Model needs 的白话与 handoff tier 的说明、Tools 的两种写法与 `all MCP tools`、Other settings、Prompt、File 与操作 | 单元、App |
| AG-10 | 操作记录 | F8 的 Recent activity 有 `Save agent <name>`、`Delete agent <name>`、`Open Customize → Agents` | App |
| AG-11 | 现有功能不退步 | 每一步：`npm run test:unit`、`test:tb-unit`、`npm run test:quick` 通过；`parseRoleFiles` 拆出 `inspectRoleFiles` 之后对同样的文件结果不变（单元）；推送前的完整回归：`node tests/ui/v1-models-existing.mjs --id AG-11` 跑这一节改到的现有界面套件——App 层 `tb-app-roles`、`m6-app-tools`、`m6-app-settings`、`mem-app-settings` 与 WP-09 改过的模型菜单套件，记进 `ag-app-existing.json`；回放层 `m6-replay`，记进 `ag-replay-existing.json`（App 层的结果只在这时写） | 单元、App |

### 9.3 不留未完成项

`tests/spec-coverage.mjs --spec agents` 读 §9.2 的编号和每条的“层”，再读 `test-results/` 里 `ag-` 开头的结果文件
（`ag-unit.json` 为单元，`ag-app*.json` 为 App（含 `ag-app-existing.json`），`--only` 写的 `ag-partial-` 开头的文件不算），规则同其他规格。单元测试的报告器 `tests/unit/ag-reporter.mjs`（严格模式，同 `tb-reporter.mjs`）。
`npm run test:agents` 依次跑单元、构建、整个 App、AG-11 的现有套件，最后运行覆盖检查；它跑整套界面测试，只在推送到远端
之前跑（§9.1），平时只跑 `test:ag-unit`。
