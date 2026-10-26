# 右栏 Changes 与顶栏的改动行数

依据：文件系统构建规格（下称“规格”，两个文件：§0–§5、§11–§19 在 [file-system.md](../../specs/file-system.md)，§6–§10 在
[file-system-permissions.md](../../specs/file-system-permissions.md)；本表引用的都在 file-system.md）的 [§3.5](../../specs/file-system.md)（git 状态）、
§4.4（快照状态）、§4.6（`mori.turn_changes`）、§5.1–§5.4（右栏与顶栏），
实现 [文件系统 Proposal](../../proposals/file-system.md) §4、§6 的“顶栏”“右栏 Changes”、§8、§13 第 14、17、19 条。
补充 [v0 changes.md](../../v0/screens/changes.md)：文件阅读器的全部状态、`← Changes`、`Reload file`、`Open in default app` 沿用它；它的“改动列表”一节由本表取代；
[team-blocked.md](team-blocked.md) 的“右栏：后台改动的说明”作废（[规格 §5.1](../../specs/file-system.md)）。Rewind 见 [fs-rewind.md](fs-rewind.md)，Initialize git 的确认框见 [fs-worktree.md](fs-worktree.md)。
界面文字为英文，写法按 [v0/ui-strings.md](../../v0/ui-strings.md)。标了“（临时，走查时可以改）”的是规格没给、本表定的。

## 来源

| 来源 | 内容 |
| --- | --- |
| `workspace.status { sessionId }` 的结果、`mori.workspace_status` 事件 | `WorkspaceStatus`（[规格 §3.5](../../specs/file-system.md)）：`git`（`ok` / `old` 带 `version`，`missing`）、`repo`（`RepoInfo`：`toplevel`、`hasCommit` 等，[规格 §3.4](../../specs/file-system.md)）、`branch`（`head`、`oid`、`upstream`、`ahead`、`behind`）、`files`（`path`、`from`、`group`、`code`，最多 500 条）、`total`、`truncated`、`error`、`snapshots`（`state`、`reason`、`error`、`skipped`、`skippedTotal`，和嵌套 git 仓库的路径 `nested`（最多 20 个）与总数 `nestedTotal`：快照里 mode 160000 的条目，相对工作路径，[规格 §4.4、§5.3](../../specs/file-system.md)） |
| 会话文件里的 `mori.turn_changes` 条目（`session.open` 给出的当前分支）与 `mori.turn_changes` 事件 | `run` 记录（`round`、`start`、`end`）与 `changes` 记录（`round`、`base`、`head`、`files` 的 `path`/`status`/`added`/`removed`、`total`、`agents`、`overlap`）（[规格 §4.6](../../specs/file-system.md)） |
| `snapshots.diff { sessionId, round, path }` 的结果 | `patch`、`binary`、`truncated`、`error` |
| 当前分支上你的消息（条目，与实时的 `mori.entry_id`）和 `mori.wake` 条目 | 轮的编号 `Turn <n>`（第几条你的消息，`[Mori]` 投递不算；会话引用的 Turn N 把投递也算进去，协作模式下两边可能不同，[规格 §5.3](../../specs/file-system.md)）和标题（这条消息的第一行） |
| 右栏这一栏的宽度 | 这一栏不宽于 600 px 时顶栏不显示 `+N −M`（[规格 §5.4](../../specs/file-system.md)） |
| 你的操作 | 打开、关闭右栏；`Refresh`；点 `+N −M`；点 git 状态里的文件；点 This session 的文件行或 `Open`；切换会话；窗口回到前台 |

`<role>` 是记录里 `agents` 的 `role`：基座 `mori` 显示为 `Mori`，其他照角色名原文；`<task>` 是 `task` 原文（如 `T2`）。

## 顶栏：`+N −M`

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 这个会话有改动 | 当前分支上的 `changes` 记录：N = 各条 `files` 的 `added` 之和，M = `removed` 之和（null 不计） | `Toggle changes` 左边一个按钮 `+N −M`（`−` 是 U+2212）；`+N` 用新增色、`−M` 用删除色；读屏名 `Changes in this session: N lines added, M removed`（N 为 1 时 `1 line added`） | 点它：打开右栏到 Changes 视图（已经在 Changes 上时不变，打开的是阅读器时切回 Changes） |
| 还没有改动 | 没有 `changes` 记录，或 N、M 都为 0 | 不显示，只有 `Toggle changes`（悬停文字由 `This session’s changes` 改为 `Changes`，读屏名不变；[规格 §5.1](../../specs/file-system.md)） | — |
| 新的一段记进来 | `mori.turn_changes` 事件（`changes`） | 数字随即更新 | 同上 |
| 只恢复了代码 | `mori.rewind`（`code: true`，`conversation: false`） | 数字**不变**：那些轮仍在当前分支上（[规格 §5.3、§5.4](../../specs/file-system.md)） | 同上 |
| 恢复了对话 | `rewind` 结果的 `entries` | 按新的当前分支重算，丢掉的轮不再计入 | 同上 |
| 没装 git、git 太低 | `WorkspaceStatus.git` 不是 `ok` | 不显示 | — |
| 窄栏 | 这一栏不宽于 600 px | 不显示（同 `Team: …` 在窄栏只剩状态点，平行 Agent 规格 §13.1） | 用 `Toggle changes` |

## 右栏的外框

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 打开在 Changes | 你打开了右栏，或这个会话第一次收到 `changes` 记录时自动打开（你手动开关过之后以你为准，沿用 v0 的临时默认值） | 标题 `Changes`（取代 `This session’s changes`）；标题右边 `Refresh`（图标按钮，悬停与读屏名 `Refresh`）和 `Close panel`（×） | `Refresh`；关闭 |
| 刷新中 | 你点了 `Refresh`：`workspace.status` 还没返回 | `Refresh` 按钮转圈、不可点（读屏名 `Refreshing…`）；下面的内容保持上一次的 | 关闭 |
| 还没有状态 | 右栏打开、这个会话还没收到过 `WorkspaceStatus` | 上半部分 `Loading…`；This session 照常从记录显示 | 关闭 |
| 打开在阅读器 | 你点了文件 | 同 v0 changes.md 的“文件”视图（`← Changes` 回到这里） | 同 v0 |
| 切换会话、去设置页再回来 | — | 右栏按会话各自记住显示哪个视图（同 v0） | — |

## 上半部分：三种文件夹

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| git 仓库 | `git.state: 'ok'`，`repo` 不为 null | 下一节“git 状态” | 见下一节 |
| 不是 git 仓库 | `git.state: 'ok'`，`repo` 为 null，`error` 为 null | 一行 `Not a git repository`，下面文字按钮 `Initialize git…`；下半部分 This session 照常 | `Initialize git…` 打开确认框（fs-worktree.md） |
| 没装 git | `git.state: 'missing'` | 整个右栏正文只有一行 `Git is required to track changes and rewind.`（照 Claude 的提示，proposal §13 第 19 条）；没有 This session，没有 v0 的编辑与写入列表 | `Refresh`（装好 git 后点它就能用，[规格 §3.2](../../specs/file-system.md)） |
| git 版本太低 | `git.state: 'old'` | 整个正文只有一行 `Git 2.31 or later is required to track changes and rewind (found <version>).` | `Refresh` |
| 认不出仓库 | `git.state: 'ok'`，`repo` 为 null，`error` 不为 null（例如 `detected dubious ownership`、工作路径不存在） | 一行 `Couldn’t read git status: <error>`（不显示 `Not a git repository`，也没有 `Initialize git…`）；下半部分 This session 照常 | `Refresh` |

## git 状态

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 分支行 | `branch` | 分支名 `<head>`；`head` 为 null 时 `HEAD detached at <oid 前 7 位>`；`oid` 为 null 时后面加 ` · No commits yet`；有 `upstream` 时加 ` · <upstream>`，再加 ` · 1 ahead`、` · 2 behind`、` · 1 ahead, 2 behind`，都为 0 时 ` · Up to date`；有 `upstream`、`ahead` 为 null 时 ` · <upstream> (gone)`；整行太长时省略号截断，悬停看全文 | — |
| 有未提交的文件 | `files` | 按组列出，组标题 `Staged · <n>`、`Unstaged · <n>`、`Untracked · <n>`、`Conflicts · <n>`（顺序 Conflicts、Staged、Unstaged、Untracked，没有的组不显示；`<n>` 是这一组在 `files` 里的条数）；每行：状态字母（`M`、`A`、`D`、`R`、`C`、`T`、`U`，悬停 `Modified`、`Added`、`Deleted`、`Renamed`、`Copied`、`Type changed`、`Conflicted`；未跟踪的不带字母）和路径（相对仓库根；重命名 `<from> → <path>`；未跟踪的目录以 `/` 结尾）；同一个文件既暂存又有未暂存的改动时两组各一行 | 点一行（Enter、空格）：在阅读器里打开 `<toplevel>\<path>` |
| 打开删掉的文件 | 阅读器 | `File not found` 和完整路径（v0） | 同 v0 |
| 打开未跟踪的目录 | 阅读器 | `Preview unavailable · This is a folder`（v0） | `Open in default app` |
| 工作路径是仓库的子文件夹 | `repo.toplevel` 与工作路径不同 | 列整个仓库的文件，路径相对仓库根（同在子文件夹里跑 `git status`，[规格 §3.5](../../specs/file-system.md)） | 同上 |
| 没有未提交的文件 | `files` 为空，`error` 为 null | 分支行下面一行 `No uncommitted changes` | — |
| 太多 | `total` 大于 `files` 的条数 | 列表下 `Showing 500 of <total> files.`（`total` 按千分位写）；`truncated` 为真时写 `Showing the first 500 files.`（总数不可知） | — |
| 读失败 | `error` 不为 null，`repo` 不为 null | 分支行的位置一行 `Couldn’t read git status: <error>` | `Refresh` |
| 你在终端里提交、切分支 | 不监视（[规格 §3.5](../../specs/file-system.md)） | 保持上一次读到的，直到下一个刷新时机（下面“刷新”一节） | `Refresh` |

## This session

数据只来自当前分支上的 `mori.turn_changes`，界面自己归组（[规格 §5.3](../../specs/file-system.md)）。git 仓库与不是 git 仓库时都有这一节，在上半部分的下面，小标题 `This session`；
嵌套仓库的说明在小标题上方，快照的说明在小标题下面。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 嵌套的 git 仓库 | `snapshots.nested` 不为空（子模块，或打开的是装着几个仓库的上级文件夹；[规格 §5.3](../../specs/file-system.md)，FS-26） | 小标题 `This session` 上方一行 `Changes inside nested repositories aren’t tracked: <路径>, <路径>`（列出 `snapshots.nested`，最多 20 个，路径相对工作路径，`, ` 隔开，长了折行；`snapshots.nestedTotal` 多于 20 时接 ` and <n> more`，`<n>` = `nestedTotal` − 20）；这些仓库里的文件不出现在 This session，Rewind 也不恢复它们 | — |
| 没有改动 | 当前分支上没有 `changes` 记录 | `No changes yet.` | — |
| 有改动 | `changes` 记录 | 每个有记录的轮一组，新的轮在上；组标题 `Turn <n> · <你那条消息的第一行>`（太长时省略号截断，悬停看这条消息全文） | 点文件行；`Open` |
| 组里的一个文件 | 这一轮各条记录里列出它的那些 `files` 项 | 一行：状态字母 `A` / `M` / `D`（悬停 `Added` / `Modified` / `Deleted`；按这一轮第一次、最后一次出现定：第一次是 A 为开始前没有，最后一次是 D 为现在没有，都不是为 M，建了又删为 D）；路径（相对工作路径）；`+<added> −<removed>`（这一轮各段之和；全部是二进制时写 `Binary`）；有别的 Agent 时写名字（见下一行）；`Open`（状态为 D 时没有）；文件按这一轮里第一次出现的先后 | 点行（Enter、空格）展开、收起它的 diff；`Open` 在阅读器里打开现在的文件 |
| 文件行上的 Agent | 列出它的那些记录的 `agents` 合起来 | 全是 `self`（只有对话本身）时不写；否则在路径后面用次要文字色写名字，`, ` 隔开：`self` 写 `<role>`，实例写 `<role> (<task>)`，没有 task 的实例只写 `<role>`；例如 `Mori, Executor (T2)` | — |
| 命令改的文件 | `changes` 记录（bash、PowerShell 改的与 edit、write 改的一样） | 与其他文件一样列出，没有“Only edits and writes are listed…”的说明 | 同上 |
| 后台 Agent 改的文件 | `changes` 记录的 `agents` 有实例 | 列在当时那一轮里，标出 Agent；没有 `Changes made by team tasks aren’t listed here.` | 同上 |
| 同一文件夹的另一个会话同时在跑 | 这一轮有 `overlap: true` 的记录 | 组标题下一行 `Another session in this folder was running at the same time, so some of these changes may be theirs.` | — |
| 一段改了太多文件 | 这一轮有 `total` 大于 `files` 条数的记录 | 组下面一行 `Some files in this turn aren’t listed. Too many changed at once.` | — |
| 快照暂停 | `snapshots.state: 'paused'` | 小标题下面一行 `snapshots.reason` 原文（例如 `Snapshots are paused for this folder: more than 20,000 new files would be added. Add generated folders to .gitignore to resume.`）；已有的轮照常列出 | — |
| 快照不可用 | `snapshots.state: 'off'`（git 是 ok，例如快照目录归属冲突） | 小标题下面一行 `snapshots.reason` 原文 | — |
| 上一次快照失败 | `snapshots.error` 不为 null | 小标题下面一行 `Couldn’t take a snapshot: <error>` | — |
| 有跳过的大文件 | `snapshots.skippedTotal` 大于 0 | 小标题下面一行 `<n> large files aren’t in snapshots (over 10 MB).`（1 个时 `1 large file isn’t in snapshots (over 10 MB).`）；悬停列出 `skipped` 里的路径（最多 20 个） | — |
| 只恢复了代码 | `mori.rewind`（`code: true`、`conversation: false`） | 那些轮照样列出（[规格 §5.3](../../specs/file-system.md)） | — |
| 恢复了对话 | `rewind` 结果的 `entries` | 按新的当前分支重新归组；丢掉的轮不列 | — |
| 新的一段记进来 | `mori.turn_changes` 事件 | 加到对应的轮里（新的轮放在最上面）；已经展开的 diff 不自动重读（临时，走查时可以改） | — |
| 重新打开会话、界面重新载入 | `session.open` 的条目 | 与实时看到的相同 | — |

## 一个文件的 diff

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 读取中 | 你点了文件行：`snapshots.diff { round, path }` 还没返回 | 行下 `Loading…` | 收起 |
| 显示 | 结果的 `patch` | 这一轮这个文件从开始到最后的 diff，用现有的 diff 组件（上下合并、长行折行，同 v0 的编辑 diff） | 收起；`Open` |
| 二进制 | `binary` 为真 | `Binary file · No preview` | `Open` |
| 没有差别 | `patch` 为空串 | `No net changes in this turn.` | — |
| 太大 | `truncated` 为真 | diff 的前 1 MB，下面 `The diff is too large to show in full.` | `Open` |
| 快照已被整理 | `error` 为 [规格 §4.7](../../specs/file-system.md) 的原文 | `Mori keeps snapshots for the last 100 turns of a session. This turn’s snapshots were removed.` | — |
| 失败 | `error` 为其他原文 | `Couldn’t load the diff: <error>` | 收起再展开重试 |

## 文件阅读器的重新读取

阅读器的状态同 v0 changes.md，只改自动重读的依据（[规格 §5.1](../../specs/file-system.md)）：

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 打开着的文件被这个会话改了 | 新的 `changes` 记录列出这个文件（路径按 pi 的规则比较，同 v0） | 自动重读一次（不管是 edit、write、命令还是后台 Agent 改的） | 同 v0 |
| 被别处改了（你、别的会话） | 没有这个会话的记录 | 不自动重读 | `Reload file` |

## 刷新

界面在这些时候发 `workspace.status`（[规格 §3.5](../../specs/file-system.md) 的表；后台进程另外在工具执行完、一轮结束、Rewind 之后自己读，结果以 `mori.workspace_status` 到达）：

| 时机 | 发给哪个会话 |
| --- | --- |
| `session.open` / `session.create` 成功 | 这个会话 |
| 焦点会话改变（点侧栏、分屏切换焦点） | 新的焦点会话 |
| 窗口回到前台（`window` 的 `focus`） | 显示着的会话（分屏时两个） |
| 打开右栏 | 这个会话 |
| 点 `Refresh` | 这个会话 |

## 反例

- 没有 `Only edits and writes are listed. Files changed by commands aren’t included.`，也没有 `Changes made by team tasks aren’t listed here.`。
- 没装 git 时不显示 v0 那份只列编辑和写入的列表（proposal §13 第 19 条）。
- git 状态里点文件不显示 git 的 diff，只打开阅读器；This session 里点文件才显示 diff。
- 只恢复代码不会让 `+N −M` 变小，也不会让 This session 里那些轮消失。
- 窗口在后台时不刷新；不监视文件，你在终端里提交后要回到 Mori 窗口或点 `Refresh` 才看到。
- 不是 git 仓库的文件夹仍有 This session。
- 别的会话独自改的文件不在这个会话的 This session 里（只有两边同时在跑的那几段才会两边都记，并写明）。
- 嵌套 git 仓库里的文件改动不在 This session 里，只有小标题上方那一行说明（[规格 §0](../../specs/file-system.md)“已知的限制”）。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：Agent 名字写在路径后面、用次要文字色；
新的一段记进来时已经展开的 diff 不自动重读；`Refresh` 转圈时保持上一次的内容；还没有状态时上半部分写 `Loading…`。嵌套仓库那一行的写法（`, ` 隔开、最多 20 个）是规格 §17 的临时默认值，不是本表定的。

## 需要规格回答

- 无。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 顶栏的行数 | `data-testid="lines-indicator"`，`data-added`、`data-removed` |
| 右栏正文 | `data-testid="changes"`（沿用 v0） |
| Refresh | `data-testid="changes-refresh"`，刷新中 `data-busy` |
| git 状态 | `data-testid="git-status"`；分支行 `git-branch`；组 `git-group`（`data-group`：`conflicted`、`staged`、`unstaged`、`untracked`）；文件行 `git-file`（`data-path`、`data-code`） |
| 三种文件夹与错误 | `not-a-repo`、`git-required`（`data-state`：`missing`、`old`）、`git-error` |
| This session | `data-testid="session-changes"`；说明行 `snapshots-note`（`data-kind`：`paused`、`off`、`error`、`skipped`）；没有改动 `session-changes-empty`；嵌套仓库的说明 `nested-repos-note`（本表定，临时） |
| 一轮 | `data-testid="turn-changes"`（`data-round` 为轮的条目 id，`data-turn` 为编号）；重叠说明 `turn-overlap`；没列全 `turn-truncated` |
| 一个文件 | `data-testid="turn-file"`（`data-path`、`data-status`、`data-added`、`data-removed`）；Agent `turn-file-agents`；`Open` 为 `turn-file-open` |
| diff | `data-testid="turn-diff"`（`data-state`：`loading`、`shown`、`binary`、`empty`、`truncated`、`pruned`、`error`） |
