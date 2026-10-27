# 消息上的 Rewind

依据：文件系统构建规格（下称“规格”，两个文件：§0–§5、§11–§19 在 [file-system.md](../../specs/file-system.md)，§6–§10 在
[file-system-permissions.md](../../specs/file-system-permissions.md)；本表引用的都在 file-system.md）的 [§4.6](../../specs/file-system.md)（`run` 记录）、
§5.5–§5.11（Rewind、冲突、恢复代码与对话、`mori.rewind` 与 Undo），
实现 [文件系统 Proposal](../../proposals/file-system.md) §4“Rewind”、§5.3、§6“你的消息”、§9 第 4 条、§13 第 17、18 条。菜单项照 Claude Code 的 checkpointing（不做 Summarize）。
右栏的 This session 见 [fs-changes.md](fs-changes.md)。界面文字为英文，写法按 [v0/ui-strings.md](../../v0/ui-strings.md)。
标了“（临时，走查时可以改）”的是规格没给、本表定的。

## 来源

| 来源 | 内容 |
| --- | --- |
| 当前分支的条目（`session.open`）与实时事件 | 你的消息（`entryId`；还没拿到为 null）；`mori.wake`（`[Mori]` 投递，不是你的消息）；`mori.turn_changes` 的 `run` 记录（这条消息有 code restore）与 `changes` 记录（这条消息之后有改动）；`mori.receipt { kind: 'registered', request }`（需求登记在哪条消息之后）；`mori.rewind` 条目与事件（通知与 Undo） |
| `WorkspaceStatus.git`（`workspace.status` 的结果、`mori.workspace_status`） | 没装 git、git 太低时没有 Rewind |
| `TeamState.busy`（`SessionInfo`、`mori.team_state`）；没有 Team 的会话为对话在运行或准备中 | 不能 Rewind |
| `SessionInfo.board` / `mori.board` 的 `requests[].status` | 哪些需求还开着 |
| `rewind`、`rewind.undo` 的结果 | `RewindResult`：`conflicts`（`conflicts`、`total`、`token`）或 `done`（`entryId`、`record`、`editorText`、`refs`、`entries`、`warning`）；失败时的错误原文 |
| 你的操作 | 悬停、Tab 到你的消息；`Rewind`；菜单项；冲突对话框的按钮；`Undo` |

## 消息上的 `Rewind`

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 平时 | 你的消息（含技能调用的气泡），`entryId` 不为 null，`git.state` 是 `ok` | 悬停在消息上、或消息里的元素有键盘焦点时，气泡旁出现文字按钮 `Rewind`（悬停说明 `Rewind to before this message`，临时，走查时可以改）；按钮一直在 Tab 顺序里，没悬停时看不见 | 点它或 Enter：打开菜单 |
| 会话忙 | `busy` 为真（任何 Agent 在运行、排队，或有待判断的消息），或这个会话正在 Rewind / Undo | `Rewind` 不可点（`aria-disabled`），悬停 `Still running`（同会话菜单的原因） | — |
| 还没拿到条目 id | 刚发出的消息，`mori.entry_id` 还没到 | 没有 `Rewind` | — |
| `[Mori]` 投递 | `mori.wake` 指向的消息不显示为你的消息 | 没有 `Rewind` | — |
| 没装 git、git 太低 | `git.state` 不是 `ok` | 任何消息上都没有 `Rewind`（右栏写明 `Git is required to track changes and rewind.`，fs-changes.md） | — |

## 菜单

菜单贴着 `Rewind` 弹出。“有 code restore”= 当前分支上有 `round` 为这条消息的 `run` 记录；“之后有改动”= 当前分支上有 `round` 为这条消息或之后你的消息的 `changes` 记录（[规格 §5.5](../../specs/file-system.md)）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 有 code restore，之后有改动 | 上面两条都成立 | `Restore code and conversation`、`Restore conversation`、`Restore code`、`Never mind` | 选一项；方向键移动、Enter 选、Esc 等于 `Never mind` |
| 有 code restore，之后没有改动 | 只有 `run` 记录 | `Restore conversation`、`Never mind`（不显示两个恢复代码的选项，照 Claude） | 同上 |
| 没有 code restore，之后有改动 | 没有 `run` 记录：生成中排队（Queue）、插话（Steer）的消息；那次快照暂停或失败；这个功能之前的旧消息 | `Restore conversation`、一行不可选的 `No code restore`（次要文字色）、`Never mind` | 同上 |
| 没有 code restore，之后没有改动 | — | `Restore conversation`、`Never mind` | 同上 |
| 有需求还开着 | 当前分支上这条消息或之后有 `mori.receipt { kind: 'registered', request: n }`，需求 n 的 `status` 是 `open` | `Restore code and conversation`、`Restore conversation` 不可选，下面一行 `Request <n> is still open. The conversation can’t go back to before it was registered.`（几个时 `Requests 1 and 3 are still open. The conversation can’t go back to before they were registered.`）；`Restore code` 照常 | `Restore code`；`Never mind` |
| 关掉 | 你选了 `Never mind`、按了 Esc、点了别处 | 菜单消失，焦点回到 `Rewind` | — |

## 进行中

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| Rewind 进行中 | 你选了一项：`rewind` 还没返回 | 菜单关闭；对话流末尾一行 `Rewinding…`；发送按钮不可用（悬停 `Rewinding…`）；所有消息上的 `Rewind` 不可点 | 等；在输入框里打字照常 |
| Undo 进行中 | 你点了 `Undo`：`rewind.undo` 还没返回 | 对话流末尾一行 `Undoing…`；同上 | 同上 |
| 在这时发消息 | 后台进程拒绝 `session.prompt`（[规格 §5.10](../../specs/file-system.md)） | 发送按钮本来不可用；万一发出，错误同 v0 的发送失败：`This session is rewinding. Send your message when it’s done.`，文字留在输入框 | — |

## 冲突

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 有冲突（Rewind） | `rewind` 返回 `kind: 'conflicts'` | 对话框 `Restore these files anyway?`；说明 `These files changed after this session’s last snapshot, or while another session was running in this folder. Restoring them discards those changes.`；列表每行：路径（相对工作路径）和原因 `Changed since the last snapshot`（`changed`）或 `Another session was running`（`overlap`）；`total` 多于列出的条数时末行 `and {n} more`；按钮 `Overwrite`、`Skip these files`、`Cancel`，焦点在 `Cancel`（临时，走查时可以改）；Tab 只在对话框里循环 | `Overwrite`：再发 `rewind`，`conflictChoice { action: 'overwrite', token }`；`Skip these files`：`action: 'skip'`；`Cancel` 或 Esc：关掉，什么都不改 |
| 有冲突（Undo） | `rewind.undo` 返回 `kind: 'conflicts'` | 同上，说明换成 `These files changed after the rewind. Undoing it discards those changes.`，原因都是 `Changed since the last snapshot` | 同上（再发 `rewind.undo`） |
| 选了之后冲突又变了 | 第二次调用又返回 `kind: 'conflicts'`（`token` 不同，[规格 §5.6](../../specs/file-system.md)） | 对话框换成新的列表（不关闭） | 同上 |
| 第二次调用进行中 | 你点了 `Overwrite` 或 `Skip these files` | 三个按钮不可用；点的那个写 `Restoring…`（Undo 时 `Undoing…`） | — |
| Cancel | 你的操作 | 对话框关闭；对话流末尾没有 `Rewinding…`；什么都没改 | — |

## 完成

通知是一行，放在对话流里 `mori.rewind` 条目的位置（Rewind 时它在当时的末尾），实时与重新打开时相同。`<n>` 是记录的 `turn`。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 恢复了代码和对话 | `rewind` 返回 `done`，`record.code`、`record.conversation` 为真；`entries` | 对话流按新的当前分支重建（这条消息和它之后的轮不在了）；这条消息的文字放回输入框、放在已有草稿之前，它的引用芯片放回芯片；末尾通知 `Restored code and conversation to before turn <n> · Undo` | `Undo`；照常对话 |
| 只恢复了代码 | `done`，`record.code` 为真、`record.conversation` 为假 | 对话不变，输入框不变；末尾通知 `Restored code to before turn <n> · Undo` | `Undo` |
| 只恢复了对话 | `done`，`record.code` 为假 | 对话流重建、文字回到输入框，同第一行；通知 `Restored conversation to before turn <n>`（没有 `Undo`） | 照常对话 |
| 代码恢复了、对话没恢复 | `done`，`warning` 不为 null | 通知 `Restored code to before turn <n> · Undo`，下一行 `<warning>`（`Couldn’t restore the conversation: <原文>`，例如 `This message has no reply to rewind.`；只在这次实时显示，重新打开后只有第一行） | `Undo` |
| 跳过了文件 | `record.counts.skipped` 大于 0 | 通知后面加 ` · Skipped <n> files`（1 个时 `1 file`），是一个可以展开的按钮，展开列出 `record.skipped` | 展开、收起 |
| 有文件没恢复成 | `record.counts.failed` 大于 0 | 通知后面加 ` · Couldn’t restore <n> files`（1 个时 `1 file`），可以展开，列出路径和原文 | 展开、收起；`Undo` |
| 右栏 | 随后的 `mori.workspace_status` | git 状态更新；This session 按 fs-changes.md 的规则（只恢复代码时那些轮还在） | — |

恢复了对话时，以及 Undo 把对话回到原来的分支时，后台进程在新的当前分支上把当前的模型选择范围（`mori.pick`）再记一次（[规格 §5.8、§5.9](../../specs/file-system.md)，FS-25）。这一条界面上看不到：
对话流里没有它，模型按钮与菜单不变；重新打开会话后范围与 Rewind 之后的一样。不为它加行。

## Undo

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 提供 Undo | 当前分支上最后一条 `mori.rewind`，`kind: 'rewind'`、`code: true`，没有 `kind: 'undo'` 指向它，它之后当前分支上没有消息条目；`git.state` 是 `ok` | 通知里的 `Undo` 是按钮 | 点它：`rewind.undo { undoId: 这条的 entryId }` |
| 会话忙 | `busy` 为真 | `Undo` 不可点，悬停 `Still running` | — |
| 不再提供 | 之后有了新的消息（你的或 `[Mori]` 投递），或又做了一次 Rewind，或已经 Undo 过 | 通知里没有 `Undo`，其余文字不变 | — |
| Undo 完成 | `rewind.undo` 返回 `done` | 那次恢复过对话的：对话流回到 Rewind 之前的分支（`entries`），输入框不变；末尾通知 `Rewind undone`（跳过、失败的文件同上加在后面）；之后没有 Redo | 照常对话 |
| Undo 了代码、对话没回去 | `rewind.undo` 返回 `done`，`warning` 不为 null（[规格 §5.9](../../specs/file-system.md) 第 5 步） | 通知 `Rewind undone`，下一行 `<warning>`（`Couldn’t restore the conversation: Mori can’t return to where it was before the rewind.`；只在这次实时显示）；对话流不变 | 照常对话 |

## 不能做的情况

后台进程拒绝时（命令失败），对话流末尾一行错误，不写进会话文件，下一次 Rewind 或发送时消失（临时，走查时可以改）：

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| Rewind 失败 | `rewind` 失败的原文 | `Couldn’t rewind: <原文>`；原文之一：`This session is still running. Stop it first.`、`This session is already rewinding.`、`This message isn’t in the conversation.`、`This message has no code snapshot.`、`This message has no reply to rewind.`（只恢复对话、这条消息后面什么都没有时，[规格 §5.8](../../specs/file-system.md)）、`Couldn’t take a snapshot: <原文>`（保险快照没拍成，什么都没改）、`Mori keeps snapshots for the last 100 turns of a session. This turn’s snapshots were removed.`、`Snapshots are paused for this folder, so code can’t be restored.`、`Git is required to track changes and rewind.`、需求还开着的那句、git 或文件系统的原文 | 再试；换一项 |
| Undo 失败 | `rewind.undo` 失败的原文 | `Couldn’t undo: <原文>`（例如 `This rewind can no longer be undone.`） | — |

## 重新载入与重启

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 界面重新载入（Ctrl+R）、重新打开会话 | `session.open` 的条目 | 菜单、通知、`Undo` 按上面的规则从条目算出，与之前相同 | 同上 |
| 后台进程在运行中途崩溃后重启 | 那次运行没有 `run` 记录（[规格 §4.5](../../specs/file-system.md)） | 那条消息的菜单按“没有 code restore” | `Restore conversation` |
| Rewind 进行中后台进程崩溃 | `rewind` 没有返回 | `Rewinding…` 换成 v0 的后台进程崩溃提示；没写下 `mori.rewind` 时重启后没有通知、没有 `Undo`，文件可能已部分恢复（这时用 git 状态与 This session 核对） | `Restart` |

## 反例

- 排队、插话的消息不提供恢复代码（它们没有自己的快照），菜单写 `No code restore`。
- 这条消息之后没有任何文件改动时，菜单里没有两个恢复代码的选项。
- 只恢复对话时不碰任何文件，也没有 `Undo`。
- 恢复代码不删除这个会话没记下的文件（你自己新建的、跳过的大文件），也不动嵌套 git 仓库里的文件，不用 `git clean`。
- 你在这个会话空闲时（两轮之间）改的文件，之后这个会话又跑过一轮，再 Rewind 到更早的消息时会被覆盖，不进冲突列表；Undo 能找回（[规格 §17](../../specs/file-system.md)）。
- 有 Agent 在运行（包括只有后台 Agent 在运行）时不能 Rewind，也不能 Undo。
- 在 `<R>/app` 里开的会话同时运行时改的文件，在 `<R>` 的会话里 Rewind 时列为 `Another session was running`（`overlap`），不会不问就被覆盖（[规格 §4.5](../../specs/file-system.md)）。
- TaskBoard 的需求、task、交接不随 Rewind 回退；有还开着的需求时，对话不能回到它登记之前，但代码可以恢复。
- `Never mind`、Esc、Cancel 不改任何东西。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：`Rewind` 的悬停说明 `Rewind to before this message`；冲突对话框焦点默认在 `Cancel`；
`Rewinding…` / `Undoing…` 与错误行都放在对话流末尾，错误行不写进会话文件、下一次操作时消失；通知里跳过、失败的文件做成可以展开的按钮。

## 需要规格回答

- 无。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 消息上的按钮 | `data-testid="rewind-button"`，`data-entry` 为消息的条目 id；不可点时 `aria-disabled="true"` |
| 菜单 | `data-testid="rewind-menu"`；项 `rewind-code-conversation`、`rewind-conversation`、`rewind-code`、`rewind-cancel`；`No code restore` 为 `rewind-no-code`；需求的说明 `rewind-blocked`（`data-requests` 为编号，逗号隔开） |
| 进行中 | `data-testid="rewind-progress"`（`data-kind`：`rewind`、`undo`） |
| 冲突对话框 | `data-testid="rewind-conflicts"`（`data-kind`：`rewind`、`undo`）；行 `rewind-conflict`（`data-path`、`data-reason`）；按钮 `rewind-overwrite`、`rewind-skip`、`rewind-conflict-cancel` |
| 通知 | `data-testid="rewind-notice"`（`data-kind`：`rewind`、`undo`；`data-code`、`data-conversation`）；`Undo` 为 `rewind-undo`；跳过、失败的展开按钮 `rewind-skipped`、`rewind-failed` |
| 错误 | `data-testid="rewind-error"` |
