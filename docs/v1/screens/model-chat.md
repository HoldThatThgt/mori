# 对话流里的模型层：提示、阶段行、说明卡与拒绝启动

依据：规格 §4.6（会话启动校验）、§5.3（排除原因的界面文字）、§5.5–§5.8、§6.1、§6.3、§9.3、§9.5、§11.4（准备中）。
补充并部分取代 [v0 chat.md](../../v0/screens/chat.md)：阶段行的“Retrying (1/3) · <原因>”、错误卡的“Go to settings”、v0 的模型按钮。
其余（对话流、工具卡、排队区、停止、后台进程退出）沿用 v0。界面文字的写法按 [v0/ui-strings.md](../../v0/ui-strings.md)。标了“（临时，走查时可以改）”的文字规格没给，是本表定的。

## 来源

| 来源 | 内容 |
| --- | --- |
| `mori.model_switch` 事件 | `{ from, to, reason, detail, hidden, at }` |
| 会话文件的 `mori.model_switch` 条目 | `{ from, to, reason, detail, replyStartedAt, anchorAt, hideUntil }`；`hideUntil` 大于 `replyStartedAt` 即有被隐藏的过程（§6.1） |
| `mori.model_rebuild` 事件 | `{ model, summary, at }` |
| 会话文件的 `mori.rebuild` 条目 | `{ model, at, summary }`（§6.3 第 2 步） |
| `mori.model_wait` | `{ active, kind: 'model' \| 'held' \| 'rebuild', model, reason, detail, until }` |
| `mori.model_queue` | `{ active, provider, providerName }` |
| `mori.model_retry` | `{ attempt, max, status, delayMs }` |
| `mori.model_unavailable` | `{ candidates: { ref, reason, detail }[], firstRequest, text, queued }` |
| `mori.model_state` 与 `SessionInfo` 里的 `ModelState` | `blocked`：`{ kind, detail, candidates, actions, verifyRefs, zone, zoneProviders }`（协作模式：见 docs/specs/parallel-agents-taskboard.md §4.4、§13.9：`kind` 加 `agents_invalid`，另有 `problems`；`actions` 加 `check_agents`、`turn_off_team`；`ModelState` 加 `pickLocked`，§12.11） |
| `mori.prompt_error` | v0 的字段加 `queued: string[]`（准备中被撤回的、准备中又发的消息） |
| pi 的事件 | 同 v0（`message_end` 的 `stopReason`、`errorMessage`，`compaction_end`，`agent_settled`） |
| 你的操作 | 发送、停止、点卡上的操作 |

写法约定（临时，走查时可以改）：

- 模型一律写全名 `<provider>/<model>`（同一个模型 id 可能在两个提供商下）。
- 原因一律用规格 §5.3 表的“界面文字”列，即 `shared/models.ts` 的 `REASON_TEXTS`（例如 `rate_limited` → “rate limited until hh:mm:ss”，
  `auth` → “API key rejected”）。说明卡、拒绝启动卡、阶段行带 until 部分；换模型提示不带（同 §6.1 的重做说明）。
- 说明卡、拒绝启动卡、菜单悬停里每个候选一行：“<provider>/<model> — <原因>”。

## 对话流里的提示

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 换了模型 | `mori.model_switch` 事件（运行中），或会话文件里的同名条目（打开、重新载入时） | 一行“Switched model: A → B · <原因>”；有被隐藏的过程（事件的 `hidden`、条目的 `hideUntil > replyStartedAt`）时加“ The new model redoes this response.”。`cancel_verified` 为 `unknown`、等满后换的，原因后加“ · Couldn’t confirm it stopped”（临时，走查时可以改；界面怎么认出见“需要规格回答”） | — |
| 被隐藏的过程 | §6.1：会话文件不改 | 换模型之前那段的助手消息和工具卡照常显示，不变淡、不折叠（规格没要求标出） | — |
| 第一个请求就换 | `mori.model_switch`，`hidden` 为假 | 只有换模型的一行，没有错误卡（MP-14） | — |
| 重建了对话 | `mori.model_rebuild` 事件，或 `mori.rebuild` 条目 | `summary` 为真：“Rebuilt the conversation for <B>: summary + recent turns”；为假：“Rebuilt the conversation for <B>: recent turns without tool calls”（§6.3 第 4 步） | — |
| 重建时的压缩 | §6.3 第 1 步：这次压缩的 `compaction_start`、`compaction_end` 后台进程不转给界面 | 运行中没有 v0 的“Compacting session…”“Compacted session”，压缩失败也没有错误卡。重新打开会话时，pi 的压缩条目照 v0 显示“Compacted session”，其后是重建的一行（§6.3 第 2 步） | — |
| 已停止 | v0 的“已停止”；本轮运行中、在排队、等模型、等它停下时按停止（MP-17） | 同 v0“Stopped · Changes made so far stay as they are”，不是错误卡 | — |

## 阶段行

模型层的阶段行与 v0 的阶段行在同一位置，本轮运行中与准备中显示（协作模式：见 docs/specs/parallel-agents-taskboard.md §13.6：分开时立项判断你的消息、对话在准备中时阶段行是 `<create role> is deciding… · 4s`，见 [team-stop.md](team-stop.md)）。模型层的等待进行时，取代 v0 的“Waiting for the model…”，
同样在后面显示已经等了多少秒（§9.3），写作“<文字> · 12s”（临时，走查时可以改），从这次等待开始计时、每秒刷新。
v0 的“Waiting for your approval”仍优先（它在工具执行时出现，与模型请求的等待不会同时发生）。

| 文字 | 开始于 | 结束于 |
| --- | --- | --- |
| Waiting for a model · <原因> | `mori.model_wait`，`active: true`、`kind: 'model'`；`<原因>` 由 `reason`、`detail`、`until` 按 §5.3 写出（最先恢复的那个候选的原因，带 until） | `active: false` 的 `mori.model_wait`；回复结束 |
| Waiting to make sure <模型> stopped · until hh:mm:ss | `mori.model_wait`，`kind: 'held'`，`model`、`until` | 同上 |
| Rebuilding the conversation for <B>… | `mori.model_wait`，`kind: 'rebuild'`，`model` 为 B（§6.3 第 1 步） | 同上；随后对话流出现重建的一行 |
| Waiting for <提供商名> | `mori.model_queue`，`active: true`，`providerName` | `active: false` 的 `mori.model_queue`；回复结束 |
| Retrying (n/m) · HTTP <status> | `mori.model_retry`（`attempt`、`max`、`status`） | 下一个有内容的事件、下一次 `mori.model_retry`、回复结束（§9.3） |

- v0 的“Retrying (1/3) · <原因>”（pi 的 `auto_retry_start`）不再出现：Mori 的会话关了 pi 的自动重试（§5.5）。
- 换 key 不提示，排队时只显示“Waiting for <提供商名>”（§5.5）。
- 等待中可以按停止（§5.7）。

## 准备中

你发消息时后台进程先选模型、需要时重建，再调 pi（§11.4）。

（2026-10-26 注：见 file-system.md §4.5、§13：选完模型之后、`agent_start` 之前，用户会话等运行开始的快照（`mori.snapshot_stage { active: true }` 到 `{ active: false }` 或 `agent_start`）时，
阶段行显示 `Taking a snapshot… · <秒数>`（`data-kind="snapshot"`，排在别的快照作业后面等的时间也算在内）；通常一秒内，大仓库的第一张可到几十秒；这时可以停止，见 [fs-changes.md](fs-changes.md)“阶段行：运行开始的快照”。）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 准备中（协作模式：见 docs/specs/parallel-agents-taskboard.md §5.3：分开时准备中先等立项判断这条消息，见 [team-stop.md](team-stop.md)） | 你发了消息（`session.prompt`），pi 还没开始运行 | 你的消息已显示在对话流里；会话按“发送中”显示（侧栏同 v0“生成中”含“刚发出”），停止可用；输入框下面一行的范围与 Effort 按钮不可用（`aria-disabled`）；阶段行显示等待（上表）或“Rebuilding the conversation for <B>…”；没有模型层的等待时阶段行不显示（选到模型、不用等时可能一闪而过） | 停止；继续发消息 |
| 准备中又发了消息（协作模式：见 docs/specs/parallel-agents-taskboard.md §5.3：分开时先进待判断队列，排队区标 `Waiting for <create role>`，判断完才进暂存） | 你在准备中按了发送（Ctrl+Enter 也按排队处理，准备中不能插话，§11.4） | 显示在排队区，标“Queued”（同 v0 的排队消息）；后台进程暂存，pi 开始后作为 followUp 交给 pi，之后同 v0。暂存期间排队区的“Withdraw”不可用（临时，走查时可以改；停止会把它们一起放回输入框） | — |
| 准备中按了停止 | `mori.prompt_error`：`message` 为“Stopped before sending”，`text` 为这条消息，`queued` 为暂存的，`running: false` | 你的消息从对话流撤回，排队区清空；这条与暂存的文字按发送顺序（空行分隔）放回输入框；没有错误卡，对话流也不加“Stopped · …”（消息已撤回，临时，走查时可以改）；合成端点不会收到请求（MP-34） | 编辑后再发 |
| 准备中 pi 没开始就结束 | `mori.prompt_error`，`message` 为 pi 的原文 | 消息撤回、文字放回输入框（同上）；v0 的错误卡，原文；卡上没有“Put your last message back in the message box”（文字已在输入框里，临时，走查时可以改） | 编辑后再发 |
| 等不到模型 | 段开始时选不到、等满 §12 的时长（§5.8）：只有 `mori.model_unavailable`（`firstRequest: true`，`text` 为撤回的消息，`queued` 为准备中又发的），没有 `mori.prompt_error` | 消息和暂存的消息撤回，文字按发送顺序（空行分隔）放回输入框；一张 No model available 卡（下节），没有错误卡 | Open settings |
| 开始生成 | pi 开始运行（`agent_start`） | 之后同 v0 | — |

## No model available

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 回复中候选耗尽 | `mori.model_unavailable`（`firstRequest: false`）；包括 `held` 等满后选不到（MP-18） | 一张说明卡，标题“No model available”；每个候选一行“<provider>/<model> — <原因>”；“Open settings”（协作模式：见 docs/specs/parallel-agents-taskboard.md §12.11：`pickLocked` 时另有 `Turn off team mode`，见 [team-blocked.md](team-blocked.md)） | Open settings |
| 段开始时候选耗尽 | `mori.model_unavailable`（`firstRequest: true`） | 同上；消息已撤回（上节） | Open settings |
| 同一次回复的 pi 错误 | 随后 pi 的 `message_end`（`stopReason: 'error'`，`errorMessage` 为 §5.8 的说明） | 不再显示 v0 的错误卡（一次失败只显示一张卡） | — |
| Open settings | 你点了它 | 设置 → Models，滚到第一个被排除候选的提供商卡；原因是 `auth`、`quota` 时焦点在它的 Keys | — |
| 压缩时没有可用模型 | pi 的 `compaction_end`，`errorMessage` 为“No model available for compaction: <每个候选及原因>”（§5.8，不等待） | v0 的“压缩失败”错误卡，原文 | Put your last message back in the message box（同 v0） |

## 拒绝启动卡

来源：`ModelState.blocked` 不为 null（会话新建、打开、改了范围、配置或档案变化、探针结束时的静态校验，§4.6）。
卡在输入框上方；`blocked` 变为 null 时卡消失，发送恢复。

| kind | 卡片文字 | 操作 |
| --- | --- | --- |
| `verifying` | “Verifying <模型>…”，`<模型>` 是第一个正在验证的候选（`blocked.candidates` 里第一个 `reason` 为 `probing` 的，§9.3）；不列其他候选 | 无；探针结束后自动重新校验 |
| `no_candidate` | “This session can’t start: no model fits.”，下面每个候选一行（`blocked.candidates`） | “Verify now”（有 `unverified` 的候选时）；“Allow <zone> for this project”（有 `zone_blocked`、且项目配置没有排除这个区域时，`<zone>` 取 `blocked.zone`，写区域代码，例如“Allow public for this project”）；“Confirm zone”（有 `zone_unconfirmed` 时）；“Change model…”；“Open settings” |
| `no_pick` | “No default model range; pick one.” | “Change model…”；“Open settings” |
| `pick_missing` | “<名字> is not in your model settings.”，第二行“Used by this session’s model range.”（§4.2 要说明谁引用了它；第二行临时，走查时可以改） | “Change model…”；“Open settings” |
| `project_config` | “.mori/models.json: <原因或原文>” | “Open settings” |
| `config_invalid` | “Model settings can’t be read: <路径>: <原文>” | “Open settings” |
| `agents_invalid`（协作模式：见 docs/specs/parallel-agents-taskboard.md §4.4、§13.9；优先于以上各项） | “Fix the agent files”，下面 `blocked.problems` 每项一行 | “Check again”（`check_agents`）；见 [team-blocked.md](team-blocked.md) |

按钮只按 `blocked.actions` 出现，顺序同上表。各操作：

| 操作 | 来源 | 结果 |
| --- | --- | --- |
| Verify now（`verify`） | 你点了它：`models.verify`（`{ refs: blocked.verifyRefs, tests: 'auto' }`） | `mori.model_state` 变为 `verifying`（没有 Verify now）；探针结束后自动重新校验，通过时卡消失 |
| Allow <zone> for this project（`allow_zone`） | 你点了它 | 打开 设置 → Models 的 Project access，焦点在这个会话的项目（§9.3）；勾选并确认后卡消失（models-settings.md） |
| Confirm zone（`confirm_zone`） | 你点了它；`blocked.zoneProviders` 是要确认的提供商 | 打开 设置 → Models，落在顶部区域未确认的那几行，焦点在 `zoneProviders` 第一个提供商那一行（§9.3）；在那里逐个确认（models-settings.md） |
| Change model…（`change_model`）（协作模式：见 docs/specs/parallel-agents-taskboard.md §12.11：`pickLocked` 时不提供，换成 `Turn off team mode`（`turn_off_team`）：`session.setTeam { mode: 'off' }`，直接回到 `off`，§5.1） | 你点了它 | 打开这一栏输入框下面一行的范围菜单（model-menu.md；往上打开，盖住这张卡；Esc 或选了以后焦点在范围按钮） |
| Open settings（`open_settings`） | 你点了它 | 设置 → Models，停在顶部 |

被拒绝启动时：

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 可以看、可以打字 | `blocked` 不为 null | 历史照常显示；输入框可以打字；发送不可用（按 Enter 不发送，草稿不丢）；斜杠命令列表照常插入文字，但提示词模板、技能命令和 `/compact` 这类要发给模型的都随发送一起不可用（§9.3）；输入框下面一行可以改范围 | 打字；改范围；卡上的操作 |
| 后台进程拒绝 | 仍有 `session.prompt` 送到（例如界面状态还没更新）：`mori.prompt_error`，`message` 为“This session can’t start: no model fits” | 消息撤回、文字放回输入框；不另显示错误卡，原因由拒绝启动卡说明（临时，走查时可以改）；各种 `kind` 都是这一句（§4.6） | — |

## v0 错误卡的规则

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 5xx 重试用完 | `server` 分类原地重试用完（§5.5），pi 的 `message_end` `stopReason: 'error'` | v0 的错误卡：原文；不换模型 | Put your last message back in the message box |
| 请求错误 | `request` 分类（其他 4xx，例如 400 参数或模板错误） | 同上 | 同上 |
| 已有输出后中断 | `partial` 分类 | 同上；已显示的部分保留 | 同上 |
| 换了模型的那次 | 换模型成功 | 没有错误卡，只有换模型的一行 | — |
| 认证类错误 | 由模型层换 key、换模型或给出 No model available 卡 | 错误卡上不再有“Go to settings”，`SETTINGS_HINT` 删除（§9.3） | — |
| 你按了停止 | 任何时候，包括排队、等模型、等它停下 | 已停止，不是错误卡 | — |

## 反例

- 一次失败只显示一张卡：发了 `mori.model_unavailable` 的那次回复没有 v0 的错误卡。
- 换 key 不出现在对话流里。
- 重建时没有 v0 的压缩提示和压缩失败卡；重建的压缩失败后换到下一个候选，对话流没有错误卡（MP-21）。
- 段内首选恢复了也不换回首选；下一段才用回首选（对话流不另提示）。
- 被拒绝启动的会话按 Enter 不发送，草稿不丢。
- 没有 pi 的 `auto_retry_*` 阶段行。
- 准备中按停止：没有错误卡，合成端点没有收到请求。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：模型写全名；候选行“<provider>/<model> — <原因>”；换模型提示的原因不带 until；
“ · Couldn’t confirm it stopped”加在原因后面；阶段行秒数写作“ · 12s”；准备中没有模型层等待时阶段行不显示；
准备中暂存的消息不能撤回；准备中按停止不加“Stopped · …”；准备中 pi 的错误卡不带“Put your last message back in the message box”；`pick_missing` 的第二行；
后台进程拒绝 `session.prompt` 时不另显示错误卡。

对 MP-17 的理解：“在排队中、等模型中、等它停下时按停止，对话流显示已停止”指 pi 已经开始运行之后的等待；
准备中（pi 还没开始）的停止按 §11.4 撤回消息，由 MP-34 检查。

## 需要规格回答

- “Couldn’t confirm it stopped”（§5.7）：`mori.model_switch` 的事件与条目都没有字段标出“等满了也没能确认停下”。
  `cancel_verified` 为 `false`（读指标确认停下后换）和 `unknown`（等满后换）的换模型，界面从 `reason`、`detail` 分不出来，
  需要规格定由哪个字段（例如 `detail` 的固定写法）告诉界面。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 换模型提示 | `[data-testid="notice"][data-kind="model-switch"]`，`data-from`、`data-to`、`data-reason`，有隐藏过程时 `data-hidden="true"` |
| 重建提示 | `[data-testid="notice"][data-kind="rebuild"]`，`data-summary`（`true` / `false`） |
| 阶段行 | `data-testid="stage"`（沿用 v0），模型层的带 `data-kind`：`wait-model`、`held`、`rebuild`、`queue`、`retry` |
| No model available | `data-testid="unavailable-card"`；候选 `[data-testid="candidate"][data-ref][data-reason]`；“Open settings” `data-action="open-settings"` |
| 拒绝启动卡 | `[data-testid="blocked-card"][data-kind]`（`blocked.kind`）；候选同上；操作按钮 `data-action`：`verify`、`allow-zone`、`confirm-zone`、`change-model`、`open-settings`（协作模式：见 docs/specs/parallel-agents-taskboard.md §13.9、§12.11：另有 `check-agents`、`turn-off-team`，问题行 `agent-problem`） |
| 排队区 | `data-testid="queue"`（沿用 v0）；准备中暂存的项带 `data-pending="true"` |
| 错误卡 | `data-testid="error-card"`（沿用 v0），不再有“Go to settings” |
