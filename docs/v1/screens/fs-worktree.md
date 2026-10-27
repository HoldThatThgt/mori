# worktree 与 Initialize git

依据：文件系统构建规格（下称“规格”，两个文件：§0–§5、§11–§19 在 [file-system.md](../../specs/file-system.md)，§6–§10 在
[file-system-permissions.md](../../specs/file-system-permissions.md)；本表引用的都在 file-system.md）的 [§11](../../specs/file-system.md)（worktree 与 Initialize git），
实现 [文件系统 Proposal](../../proposals/file-system.md) §5.4、§6、§13 第 8–13 条。git 状态的来源见 [规格 §3](../../specs/file-system.md)，右栏的 “Not a git repository” 与 “Git is required” 见 [fs-changes.md](fs-changes.md)，
权限按钮见 [fs-permissions.md](fs-permissions.md)。补充 [v0 sessions.md](../../v0/screens/sessions.md)：侧栏、右键菜单、归档与删除、打开失败的其余部分沿用它。
界面文字按 [v0/ui-strings.md](../../v0/ui-strings.md)；标了“（临时，走查时可以改）”的是规格的临时默认值（登记在 [规格 §17](../../specs/file-system.md)）或本表定的界面细节。

## 来源

| 来源 | 内容 |
| --- | --- |
| `mori.workspace_status` 事件（[规格 §3.5](../../specs/file-system.md) 的 `WorkspaceStatus`） | 这个会话的 git 状态：`git.state`（`ok` / `old` / `missing`）、`repo`（不是 git 仓库时为 null）、`repo.hasCommit`、`error` |
| `SessionInfo.worktree`（`session.create`、`session.open`、`session.prompt` 的结果） | 这个会话拥有的 worktree `{ path, branch, mainFolder }`；没有时为 null |
| `session.prompt { …, worktree: true }` 的结果 | 重建后的会话信息 `session`（同一个 `sessionId`） |
| `mori.prompt_error` 事件 | 建 worktree 失败：`Couldn’t create the worktree: <原因>`，带这条消息的 `text`、`refs` |
| `session.list` 的 `cwd`、`SessionInfo.cwd`（经 [规格 §11.3](../../specs/file-system.md) 的 `worktreeOf` / `projectFolder` 按路径算，不调 git） | 会话的主文件夹与分支标签（侧栏、顶栏） |
| `worktrees.list` 的结果 | 拥有 worktree 的会话：`path`、`branch`、`exists`、`changes`、`inUse` |
| `worktrees.cleanUp` 的结果 | 每个 worktree 删了没有、为什么没删、错误原文 |
| `workspace.initGit` 的结果 | 成功，或失败的原文 |
| `session.open` 的结果 | 打开 worktree 不在的会话：检出成功后照常打开，或失败的原文 |
| 你的操作 | 开关、发送、Initialize git…、确认框、归档、删除、进入设置页的 Storage |

## 输入框下一行：Worktree 开关与 Initialize git…

位置：紧跟在权限按钮之后，和它一起靠左（原来推开右边一组的 `margin-left: auto` 改到开关后面那一项）；Tab 顺序同位置。
下表的“显示”都要求：会话已打开（不在 “Starting…”）、还没有你的消息、不在发送中或运行中、`SessionInfo.worktree` 为 null、不在建 worktree 中。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| git 状态还没到 | 会话刚打开，还没有 `mori.workspace_status` | 两样都不显示 | — |
| 有提交的 git 仓库 | `mori.workspace_status`：`git.state` 为 `ok`、`repo.hasCommit` 为真 | `Worktree` 开关（`data-testid="worktree-toggle"`），默认关（`aria-pressed="false"`）；悬停 `Work in a separate worktree on a new branch. It starts with only the committed files.`（临时，走查时可以改） | 点或 Space / Enter 开关；之后照常写消息 |
| 开关打开 | 你的操作 | `Worktree` 显示为打开（`aria-pressed="true"`）；不发命令；切走再回来仍是打开；不跨重启（还没保存的会话本来就不跨重启） | 再点关掉；发送（下一节） |
| 在 Mori worktree 里开的会话 | 在 worktree 会话里按 Ctrl+N 或 New session（会话在同一个 worktree 里）；`mori.workspace_status` 是有提交的仓库 | 同“有提交的 git 仓库”；打开后新 worktree 从这个 worktree 的 HEAD 切出，没提交的改动不带过去 | 同上 |
| 是 git 仓库、还没有提交 | `mori.workspace_status`：`repo` 不为 null、`hasCommit` 为假 | 两样都不显示 | 你自己提交一次后，下次读状态时出现开关 |
| 不是 git 仓库 | `mori.workspace_status`：`git.state` 为 `ok`、`repo` 为 null、`error` 为 null | `Initialize git…`（文字按钮，`data-testid="init-git"`）；悬停 `Make this folder a git repository so sessions can use worktrees`（临时，走查时可以改） | 点了打开 Initialize git 确认框（下面） |
| 读 git 状态出错 | `mori.workspace_status`：`error` 不为 null（例如 `detected dubious ownership`） | 两样都不显示（右栏显示原文，fs-changes.md） | — |
| 没装 git、git 太旧 | `mori.workspace_status`：`git.state` 为 `missing` / `old` | 两样都不显示（右栏另有说明，fs-changes.md） | — |
| 已经有消息、发送中，或会话有了自己的 worktree | 对话流里有你的消息或先显示的消息；`SessionInfo.worktree` 不为 null | 两样都不显示 | — |
| 窄栏 | 这一栏 ≤ 460px（权限、范围、Effort 去掉 ▾ 的同一档，v0 models.md “窄栏”） | 开关和 `Initialize git…` 只显示新图标 `branch`，读屏名仍是 `Worktree` / `Initialize git…`，悬停第一行是名字、第二行是上面的说明；这一项不截短，放不下时照 models.md “放不下”的次序截别的项；这一行不换行（临时，走查时可以改） | 同上 |

## 发第一条消息时建 worktree

worktree 放在哪里、从哪里切出（[规格 §11.2](../../specs/file-system.md)；在子文件夹里开、从哪个 HEAD 切出是负责人 2026-10-26 定的，见 [规格 §0](../../specs/file-system.md)“写规格时定的”）：

- **位置**：仓库根的 `.mori/worktrees/<名字>`，分支 `mori/<名字>`。在仓库的子文件夹 `<仓库根>/<sub>` 里开的会话，worktree 仍建在仓库根下，
  会话的工作路径是 worktree 里同一个子文件夹 `<仓库根>/.mori/worktrees/<名字>/<sub>`；侧栏仍归在你打开的那个子文件夹的一组（下面“侧栏与顶栏”）。
- **切出点**：你开这个会话的那个文件夹当前的 HEAD（不联网）。在主文件夹里开的会话就是主文件夹当前分支的 HEAD；在 worktree 会话的文件夹里开的会话
  （例如在 worktree 会话里按 Ctrl+N）是那个 worktree 的 HEAD，那里没提交的改动不带过去；新的 worktree 与它并列放在同一个仓库根下，不套在里面。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 建 worktree 中 | 你在开关打开时发送：`session.prompt { worktree: true }` 还没返回 | 你的消息先显示在对话流里（同现在）；阶段行 `Creating worktree…`（转圈）；Stop 不可用；输入框下一行的按钮、顶栏的协作开关不可用，悬停 `Creating worktree…`；输入框能打字、不能发送（临时，走查时可以改）；侧栏这一行状态 “Running”；右栏的 git 状态停在建之前的样子（这期间不读，切到它、窗口回到前台也不读） | 打字；切到别的会话（建 worktree 继续） |
| 建好、消息已发出 | 结果带 `session`；随后后台进程发的 `mori.workspace_status` | 同一个标签：阶段行换成平常的（等模型、回复中）；开关不再出现；权限按钮与 Allowed for this session（同一份批准状态）、范围、Effort、会话名、协作模式都保持你发送前选的（[规格 §11.5.4](../../specs/file-system.md)）；顶栏项目名仍是主文件夹名，悬停是 worktree 路径；侧栏这一行仍在主文件夹那一组，会话名后多出分支标签 `mori/<名字>`；右栏的 git 状态换成 worktree 的（分支 `mori/<名字>`）；带了文件引用时，你的消息上方仍是芯片、气泡里只有你写的字 | 照常对话 |
| 建 worktree 失败 | `mori.prompt_error`（`Couldn’t create the worktree: <原因>`） | 先显示的消息撤回；文字和引用芯片回到输入框；对话流里一张错误卡，写这句原文，不带 “Put your last message back in the message box”；开关仍打开 | 改好后再发；关掉开关再发（在原文件夹里） |
| 失败的原因 | 同上 | `<原因>` 是这几种之一或 git 的原文：`Git is required to create a worktree.`、`This folder isn’t a git repository.`、`This repository has no commits yet.`、`This session already has messages.`、`This session is still running. Stop it first.`、`<路径> already exists.`、`The folder <sub> isn’t committed yet, so a worktree can’t start there. Commit it first.`（在仓库的子文件夹里开、那个子文件夹还没提交时）、`This repository sets core.worktree, so Mori can’t create a worktree here. Move it to the main worktree’s config.worktree first.`（这两种什么都没改）、`This folder’s path doesn’t lead to its repository root <toplevel>, so Mori can’t place a worktree here.`（会话的文件夹本身是指进仓库子文件夹的目录联接或 subst 盘，什么都没改）、`timed out after 120 seconds`（git 的慢步骤超过 120 秒；快的步骤 10 秒，原文同样写法）（2026-10-27 注：负责人不在时按推荐定，待复核）；被拒绝启动时同现在（不加 `Couldn’t create the worktree: ` 前缀） | — |
| 建好了、消息没能发出 | 结果带 `session`，之后的 `mori.prompt_error` / 没有可用模型的卡（同现在） | 同现在的准备中失败；会话已经在 worktree 里，开关不再出现 | 照常再发（在 worktree 里） |
| 在原文件夹也重建不起来 | `session.prompt` 命令失败 | 对话流里错误卡带 “Put your last message back in the message box”；同 sessions.md “新建或打开失败”：横幅 `Failed to open session: <原文>`，会话行 “Error” | 放回消息；再点会话行在原文件夹重新建；Delete… |
| 建 worktree 中又发命令 | 你在侧栏改名等 | 那个操作失败，原文 `The worktree is still being created.`（改名框里 `Couldn’t rename this session: The worktree is still being created.`） | 等建好 |

## Initialize git 确认框

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 打开 | 你点了输入框下一行或右栏的 `Initialize git…` | 对话框 `Initialize git in “<文件夹名>”?`；说明 `Mori will run git init in this folder and commit its current files as the first commit. Files matched by .gitignore aren’t included. Afterward, new sessions here can use a worktree.`；下一行完整路径；按钮 `Initialize git` 和 `Cancel`，焦点在 `Cancel`（临时，走查时可以改）；Tab 只在两个按钮之间切换 | Initialize git；Cancel 或 Esc |
| 进行中 | 你点了 `Initialize git`：`workspace.initGit` 还没返回 | 按钮文字 `Initializing…`，两个按钮不可用；Esc 不起作用 | — |
| 成功 | `workspace.initGit` 返回；随后 `mori.workspace_status` | 对话框关闭；输入框下一行的 `Initialize git…` 换成 `Worktree` 开关（还没发消息时）；右栏换成 git 状态（fs-changes.md） | 打开开关；照常对话 |
| 失败 | `workspace.initGit` 报错 | 对话框里 `Couldn’t initialize git: <原因>`；按钮恢复可用 | 再点 `Initialize git` 重试；Cancel |
| 失败的原因 | 同上 | 这几种之一或 git 的原文：`Git needs your name and email for the first commit. Set user.name and user.email with git config --global, then try again.`（这时什么都没做）、`This folder is already a git repository.`、`This session is still running. Stop it first.`、`Git is required to initialize a repository.`、认仓库出错的原文（例如 `detected dubious ownership …`，这时什么都没做）、超时时的 `timed out after 120 seconds`；`git init` 之后才失败时 Mori 删掉它刚建的 `.git`，失败后文件夹里没有 `.git`，可以再点 `Initialize git` 重试（输入框下一行与右栏仍是“不是 git 仓库”） | — |
| 同一文件夹里别的开着的会话 | 同一个 `mori.workspace_status`（[规格 §3.5](../../specs/file-system.md) 发给这个工作路径上所有开着的用户会话） | 一起换成 `Worktree` 开关（还没发消息的）与 git 状态；开在它的子文件夹里的会话在它们下次读状态时（例如切到它）才变 | — |

## 侧栏与顶栏

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 项目分组 | `session.list` 的 `cwd` 经 `projectFolder`；本次打开的标签的 `cwd` 同样 | worktree 里的会话（拥有 worktree 的，和在 worktree 里另开的）归在主文件夹那一组；组名是主文件夹名，悬停主文件夹完整路径；不在 worktree 里的会话分组同现在 | 同 sessions.md |
| 分支标签 | `worktreeOf(cwd).branch` | 会话名之后、状态之前，次要文字色，例如 `mori/fix-login-3fa9c1`；空间不够时先截断分支标签（临时，走查时可以改）；悬停整行 `<会话名> · <分支>`；读屏名称里包含它 | — |
| 已归档的 worktree 会话 | 同上，在 “Archived” 里 | 行悬停 `<主文件夹名> · <会话名> · <分支>` | 同 sessions.md |
| 顶栏 | 当前会话的 `cwd` | 项目名是主文件夹名，悬停是工作路径（worktree 的完整路径） | — |
| 子文件夹里开的 worktree 会话 | `cwd` 为 `<仓库>/.mori/worktrees/<名字>/<sub>` | 归在 `<仓库>/<sub>` 那一组（你打开的子文件夹） | — |

## 归档、恢复、删除

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 归档 worktree 会话 | 你选了 “Archive”：`worktrees.list`、`session.close`、记进已归档列表，然后 `worktrees.cleanUp { force: false }` | 同 sessions.md “归档”：不确认，行移到 “Archived”；worktree 干净时删掉（连同 `.work/` 里的草稿和被忽略的文件），分支留着；有改动、正被别的开着的会话用着、删除失败时留着；这几种情况界面上都不另外提示（临时，走查时可以改） | — |
| 恢复 | 你选了 “Unarchive” | 同 sessions.md；不动磁盘，worktree 在打开时检出（下一节） | — |
| 点已归档的 worktree 会话 | 你的操作：恢复并打开 | 同下一节“打开 worktree 不在的会话” | — |
| 删除确认框，正在读 worktree | 你选了 “Delete…”，会话是 worktree 里的会话：`worktrees.list` 还没返回 | 同 sessions.md 的删除确认框，说明后面多一行 `Checking its worktree…`；Delete 不可用（`aria-disabled`），直到 `worktrees.list` 返回或失败（[规格 §11.9.5](../../specs/file-system.md)） | Cancel 或 Esc |
| 有拥有的 worktree，干净 | `worktrees.list`：`exists`、`changes: false`、`inUse: false` | 多一句 `Its worktree “<名字>” will also be deleted. The branch <branch> is kept.` | 同上 |
| 有拥有的 worktree，有改动 | `changes: true` | 多一句 `Its worktree “<名字>” and the uncommitted changes in it will also be deleted. The branch <branch> is kept.` | 同上 |
| 读不出有没有改动 | `changes: null`（`exists` 为真）或 `worktrees.list` 失败（这时名字、分支取 `worktreeOf(cwd)`） | 多一句 `Its worktree “<名字>” will also be deleted, with any uncommitted changes in it. The branch <branch> is kept.`；Delete 可用 | Delete（`worktrees.list` 失败时按有拥有的 worktree 删：`worktrees.cleanUp { paths: [worktreeOf(cwd).path], force: true }`）；Cancel 或 Esc |
| 别的开着的会话在用 | `inUse: true` | 多一句 `Its worktree “<名字>” is kept because another open session uses it.` | 同上 |
| 没装 git | `worktrees.list` 的 `git: false`，有这一项、`exists` 为真 | 多一句 `Its worktree “<名字>” is kept because Git is required to delete it.`；点 Delete 只删会话，worktree 文件夹留着（临时，走查时可以改） | 同上 |
| 没有拥有的 worktree，或它已经不在 | `worktrees.list` 没有这一项，或 `exists: false` | 同 sessions.md，不加句子 | 同上 |
| 还没保存的 worktree 会话 | 会话没有消息、`SessionInfo.worktree` 不为 null | 说明是 `This session has no messages yet.`，后面同样加上面的一句 | 同上 |
| 删除中 | 你点了 Delete：`session.close`、`worktrees.cleanUp { force: true }`、删会话文件 | 同 sessions.md “Deleting…” | — |
| 删 worktree 失败 | `worktrees.cleanUp` 的结果带 `error` | 对话框里 `Couldn’t delete this session: <原文>`；会话文件还在；会话已关闭（同 sessions.md “已关闭、删除文件失败”） | 再点 Delete 重试；Cancel |
| 已删除 | 各步都成功 | 同 sessions.md “已删除”；分支 `mori/<名字>` 还在仓库里 | — |

## 打开 worktree 不在的会话

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 检出中 | 你点开工作路径在 Mori worktree 里、文件夹不在了的会话：`session.open` 还没返回 | 同 sessions.md “打开已保存的会话”：按钮位置 “Starting…” | — |
| 检出成功 | `session.open` 返回 | 照常打开；worktree 是分支 `mori/<名字>` 的最新提交；不另外提示。worktree 里有要信任的 `.pi/` 内容、主文件夹没记住过、本次也没回答过时，按“没问过”打开（项目资源不加载，同 sessions.md “项目信任”），不另弹询问 | 照常对话 |
| worktree 根还在、cwd 那个子文件夹不在 | `session.open` 报错 | 同 sessions.md：横幅 `Failed to open session: Project folder not found: <cwd>`，不检出 | 同 sessions.md |
| 分支不在了 | `session.open` 报错 | 横幅 `Failed to open session: The branch <branch> no longer exists, so this session’s worktree can’t be restored.`；会话行 “Error” | 再点重试；Delete… |
| 仓库根不在了 | 同上 | 横幅 `Failed to open session: Project folder not found: <R>`（worktree 所在仓库的根，[规格 §11.2](../../specs/file-system.md) 的 R） | 同上 |
| 没装 git | 同上 | 横幅 `Failed to open session: Git is required to restore this session’s worktree.` | 同上 |
| 分支正在别的 worktree 里检出 | 同上 | 横幅 `Failed to open session: ` 加 git 的原文 | 同上 |
| 检出超时 | 同上（`worktree add` 超过 120 秒，建了一半的已清掉，分支留着） | 横幅 `Failed to open session: Restoring the worktree timed out after 120 seconds.` | 同上 |
| 留下锁着的登记 | 上一次检出被结束，`.git/worktrees/<名字>/locked` 还在、文件夹不在 | 同“检出中”“检出成功”：先清掉那条登记再检出，不另外提示 | 照常对话 |
| 文件夹在、git 里没有它的登记 | `session.open` 报错（例如删 worktree 时只删了登记、文件夹留下） | 横幅 `Failed to open session: The worktree folder <path> exists but isn’t registered with git. Move or delete it, then open this session again.`；Mori 不删那个文件夹 | 移走或删掉文件夹后再点；Delete… |

## 设置页：Storage → Worktrees

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 分节 | — | 设置页左边多一节 `Storage`（照 Claude 的 Settings > Storage，[规格 §11.10](../../specs/file-system.md)；排在 `General` 之后，规格 §17 的临时默认值；When you’re away 在 `General`，见 [fs-question.md](fs-question.md)）；里面一块标题 `Worktrees`，说明 `Archived sessions keep their worktree when it has uncommitted changes. Clean up deletes these worktrees and the changes in them. Branches and sessions are kept.` | — |
| 读取中 | 你进入这一节：`worktrees.list`（已归档、`worktreeOf` 不为 null 的会话）还没返回 | `Loading…` | — |
| 有留下的 worktree | `worktrees.list` 里 `exists` 的项 | 每项一行：会话名、分支、`Uncommitted changes` / `No uncommitted changes` / `In use by an open session`；按钮 `Clean up worktrees…` | Clean up worktrees… |
| 没有 | 没有 `exists` 的项 | `No worktrees are left from archived sessions.`；`Clean up worktrees…` 不可用 | — |
| 都在用 | 所有项都是 `inUse` | 列表照常；`Clean up worktrees…` 不可用 | — |
| 没装 git | `worktrees.list` 的 `git: false` | `Git is required to clean up worktrees.`；不显示列表和按钮 | — |
| 读取失败 | `worktrees.list` 报错 | `Couldn’t load worktrees: <原文>` 和 `Retry` | Retry |
| 确认 | 你点了 `Clean up worktrees…` | 对话框 `Clean up N worktrees?`（1 个时 `Clean up 1 worktree?`，N 不算在用的）；说明 `These worktrees and the uncommitted changes in them will be deleted. Their branches and sessions are kept. This can’t be undone.`；按钮 `Clean up`（危险色）和 `Cancel`，焦点在 `Cancel` | Clean up；Cancel 或 Esc |
| 清理中 | 你点了 `Clean up`：`worktrees.cleanUp { force: true }` 还没返回 | 按钮文字 `Cleaning up…`，两个按钮不可用；Esc 不起作用 | — |
| 完成 | `worktrees.cleanUp` 返回，随后再读一次 `worktrees.list` | 对话框关闭；列表只剩没删掉的；删失败的在列表下面各一行 `Couldn’t delete <branch>: <原文>`；在用的仍标 `In use by an open session` | — |
| 后台 | — | 不进这一节时什么都不做：没有定时清理、没有按天数清理、不读 worktree（[规格 §11.10](../../specs/file-system.md)） | — |
| 没写盘就退出留下的 worktree | 第一条消息还没写进会话文件时 Mori 退出；`worktrees.list` 的结果里没有它（只列已归档会话拥有的 worktree） | 这一节列不出它，它留在磁盘上（[规格 §0](../../specs/file-system.md)“已知的限制”） | — |

## 后台进程重新载入、界面重新加载

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 界面重新加载（Ctrl+R）时正在建 worktree | 后台进程照常做完；`session.list` 的还没保存的会话 | 重新加载后会话按建好后的工作路径出现在主文件夹那一组（git 步骤中读到的列表里它还在原文件夹那一组；正好在重建那一刻读到的列表里没有它，旧的已关、新的还没登记；下次读列表时都按新的工作路径出现）；之后同 sessions.md | 点开接上 |
| 后台进程重新载入，worktree 会话还没保存 | [v0 chat.md](../../v0/screens/chat.md) “会话还没保存过” | 同现在：在同一个文件夹（worktree）里新建会话；这个新会话没有 `mori.worktree`，开关按上面“在 Mori worktree 里开的会话”一行显示（[规格 §0](../../specs/file-system.md)“已知的限制”） | 照常 |

## 需要规格回答

无。原来的两处未定已经定下：Clean up worktrees 放在单独的 `Storage` 一节（[规格 §11.10](../../specs/file-system.md)，与 [§9.6](../../specs/file-system-permissions.md) 的 `General` 两节都留；
`Storage` 排在 `General` 之后是规格 §17 的临时默认值）；后台进程重新载入后重建的会话没有 `mori.worktree`，记作已知的限制（[规格 §0](../../specs/file-system.md)）。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| Worktree 开关 | `data-testid="worktree-toggle"`（`aria-pressed`） |
| 输入框下一行的 Initialize git… | `data-testid="init-git"` |
| Initialize git 确认框 | `data-testid="init-git-dialog"` |
| 侧栏分支标签 | `data-testid="session-branch"` |
| 删除确认框里 worktree 的一句 | `data-testid="delete-worktree-note"`（`data-kind`：`clean`、`changes`、`unknown`、`in-use`、`no-git`） |
| 设置页 Storage 分节 | `settings-nav` 的 `button[data-section="storage"]` |
| Worktrees 列表项 | `data-testid="worktree-item"`（`data-path`） |
| Clean up worktrees… | `data-testid="worktrees-cleanup"` |

除沿用 v0 的以外都是本表定的，临时，走查时可以改。
