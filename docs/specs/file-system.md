# 文件系统构建规格

状态：构建规格，按 [文件系统 Proposal](../proposals/file-system.md) 第一版（2026-10-26）写成，待评审。更新日期：2026-10-26。

本文是 proposal 的实现说明：proposal 讲心智模型，本文讲在 Mori 里怎么做、做到什么算完成。
两者冲突时以 proposal 为准；本文不另加 proposal 没有的行为（§17 的临时默认值与 §0 列出的写规格时定的除外）。proposal 没定、实现又必须有一个值的地方，
本文给出临时默认值，登记在 [v1/defaults.md](../v1/defaults.md) 新一节“文件系统”（§17）。检查记录、实测结果与未验证项将来在 `docs/v1/fs-checks.md`（实现时新建，§18）。

本文属于 [app-v0](../app-v0.md) §6“后台进程只做的事”新增的第 9 件“工作区”：工作区模块、快照模块、路径闸、无人应答模块、`ask_user_question`（proposal §10）。
本文改到的别的规格条目在那边注明“（2026-10-26 注：见 file-system.md §n）”，§6–§10 写 file-system-permissions.md §n（§18）。

本文分两个文件，节号连续：本文件是 §0–§5 与 §11–§19；§6–§10（路径闸、命令分析与 `.work`、收窄、你不在、`ask_user_question`）在
[file-system-permissions.md](file-system-permissions.md)。§12–§19 的汇总表（命令与事件、界面、模型看到的文字、临时默认值、要改的文件、验收）也包括 §6–§10。
代码引用写相对仓库根的路径与行号（`app/src/...:行号`、`app/node_modules/@earendil-works/pi-coding-agent/dist/...:行号`）。

## 0. 范围

**本规格实现** proposal 的全部内容（proposal §11 第 3 条的三步——权限、git、并行——都写在本规格里；实现仍按那三步依次做，每一步都能在 App 里走查，AGENTS.md 工作约定第 3 条）：

- 找 git、认仓库、读 git 状态，只在事件发生时读（§3）；
- 内部仓库与快照：每次运行前后各拍一张、按工作路径排队的时间线、排除与上限、一轮的改动 `mori.turn_changes`、保留与整理（§4）；
- 右栏 Changes（git 状态与 This session）、顶栏 `+N −M`、消息上的 Rewind、冲突、恢复代码与对话、Undo（§5）；
- 路径闸：调用分类、路径解析与链接、受保护路径、Ask each time / Full access、按工具名与按目录的本会话放行、MCP、没人能批的会话、批准卡的 `scope` 与 `targets`（§6）；
- 命令分析（bash 与 PowerShell 的写入目标、换目录、只读命令）、`.work` 与命令的 TEMP / TMP / TMPDIR（§7）；
- 收窄：`limits` 代替 `read_only` 与按角色、按模式的工具开关，程序给的收窄，写入锁，增强会话（§8）；
- 你不在：窗口焦点、计时、到时的默认答案、`mori.away_decision`、`agent_before_settle` 提醒、设置 When you’re away（§9）；
- `ask_user_question` 与提问卡、协作模式分开时转给立项、交接里的选项（§10）；
- Worktree 开关、第一条消息时建 worktree、按主文件夹算项目、归档/恢复/删除、设置页 Clean up worktrees、Initialize git（§11）；
- 现有测试随之调整（§19.4）。

**已定的**（proposal §12，2026-10-26）：

1. git 仓库也用 Mori 自己的快照回退：每次运行前后各一张，存在工作路径外，不碰你的分支、暂存区和提交（第 1 条；§4）。
2. 命令写到外面：执行前分析命令，同时把 TEMP / TMP 指到 `.work/tmp`；明说这不是沙箱，这一轮不做 Windows 沙箱（第 2 条；§7）。
3. 只有 Ask each time 与 Full access，去掉 Allow all；新会话从 Ask each time 开始，不按文件夹记住（第 3 条；§6.7）。
4. 收窄 subagent：关掉写（连带命令）、命令、MCP，缩小可写路径；只能收窄；去掉角色的 `tools:` 与只读 task 的工具裁剪（第 4 条；§8）。
5. Worktree 照 Claude：输入框下一行的开关，默认关（第 5 条；§11.4）。
6. 不是 git 仓库的文件夹：几个会话共用，各自的快照回退照常；开关换成 Initialize git（第 6 条；§11.4、§11.11）。
7. 受保护路径照 Claude：Full access 下写 `.git`、`.mori`、`.pi`、`.vscode` 等也要问（第 7 条；§6.5）。
8. 提问工具照 Claude 的 AskUserQuestion，推荐项必填，只给跟你对话的 Agent（第 8 条；§10）。
9. 你不在 5 分钟后按默认处理；只在窗口不在前台时计时，切回清零；最后 20 秒倒计时；后台 Agent 的卡一样；可改 60 秒、10 分钟、Never（第 9 条；§9）。
10. 告知：工具结果里写明；`agent_before_settle` 提醒一次，多一次请求；程序生成的 Decided while you were away（第 10 条；§9.4、§9.8、§9.9）。
11. 合并照 Claude：不放合并按钮，让 Agent 做；归档时干净的 worktree 删掉，有改动的留着（第 11 条；§11.9）。
12. 要求系统装 git，不自带 MinGit；没装时相关功能不可用，并且明说（第 12 条；§3.2、§5.1）。

**按默认定下的**（proposal §13 的二十条，2026-10-26）：

1. 写到外面的卡上有 “Allow writes to <目录> for this session”，目录取目标文件所在的目录（§6.9）。
2. MCP 在 Full access 下不问，也不分析参数（§6.10）。
3. 立项、结案、订阅实例和临时提问：工具同大家，程序收窄 `{ write: false }`（§8.3）。
4. 协作模式下的对话 Agent：工具不变，程序收窄 `{ write: false, mcp: false }`，理由写明只转达（§8.3）。
5. 协作模式分开时提问卡的答复转给立项；task 等你拿主意时对话 Agent 也用提问卡，推荐项取自交接（§10.7、§10.8）。
6. 你不在时扩展的确认和选择按取消处理（§9.4、§10.9）。
7. 工具叫 `ask_user_question`，不要批准（§10.1）。
8. worktree 放 `<主文件夹>/.mori/worktrees/<名字>`，不能改；每个 worktree 写 `core.longpaths=true`（§11.2、§11.5.3）。
9. 从主文件夹当前分支的 HEAD 切出，不联网（§11.2；按写规格时定的第 6 条理解）。
10. `.mori/agents`、`.mori/models.json` 从主文件夹读；`.pi/` 与 AGENTS.md 按 pi 的规则从 worktree 读（§11.8）。
11. worktree 会话的记忆、增强、反馈、模型的项目访问按主文件夹算（§11.7）。
12. 删除确认框写明 worktree 和里面没提交的改动一起删，分支留着（§11.9.5）。
13. Initialize git 按 `.gitignore` 做第一次提交，确认框写明；还没有提交的 git 仓库不显示 Worktree（§11.4、§11.11）。
14. 单个未跟踪文件超过 10 MB 不进快照；不是 git 仓库的文件夹默认排除 `node_modules`、`.venv`、`dist`、`build`、`target`；一次要加超过 20000 个文件时暂停快照（§4.3、§4.4）。
15. 快照存在 `%LOCALAPPDATA%\Mori\snapshots`，不放进 `%APPDATA%\Mori`（§4.1）。
16. 每个会话保留最近 100 轮；会话删除时一起删；内部仓库的整理只在删除会话时做（§4.7）。
17. 同一文件夹两个会话同时在跑：一轮的改动会把另一个会话写的也算进来，接受；Rewind 时这些文件进冲突列表（§4.5、§5.6）。
18. 会话里任何 Agent 在运行时不能 Rewind；后台 Agent 改的文件一起退；TaskBoard 不回退，有还没关闭的需求时不能把对话恢复到它立项之前（§5.5、§5.8）。
19. 没装 git 时右栏只显示 “Git is required to track changes and rewind.”，不再列编辑和写入（§5.1）。
20. 增强会话里写到外面或受保护路径的命令直接拒绝，因为没人能批（§6.11、§8.10）。

**写规格时定的**（负责人，2026-10-26，proposal 没写到）：

1. **不做兼容**（负责人：“我们不做兼容，就是打不开”）：`BoardTask.limits` 必填；当前版本存下的、task 带 `readOnly` 的 `board.json` 读不出来，这个会话打不开，
   按现在读不出 TaskBoard 的处理和提示（§8.8；验收 FS-63）。不保留“limits 可选、缺省为不限”的做法。
2. **工具被裁过的旧会话拒绝打开**：重新打开会话时，pi 恢复的工具里缺了这个会话应有的 pi 默认工具（按 pi 设置的 `defaultTools`）就拒绝打开，
   显示 “This session was saved by an older version of Mori and can’t be opened.”；不补工具（§8.6；验收 FS-68）。
3. 协作模式分开时提问卡的答复走立项 Agent 的投递队列，不进界面上可见的待判断队列（§10.7）。
4. 交接里的选项与推荐项在 `ask_user`、`relay`、`create_need_user` 三种投递里都带（§10.8）。
5. 在仓库子文件夹里开 Worktree：worktree 建在仓库根的 `.mori/worktrees/<名字>`，会话的工作路径是 worktree 里同一个子文件夹；侧栏仍归在打开的那个子文件夹下（§11.2）。
6. 切出点：从你开会话的那个文件夹当前的 HEAD 切出；在 worktree 会话的文件夹里开时就是那个 worktree 的 HEAD（proposal §13 第 9 条按此理解，§11.2）。
7. Rewind 恢复对话后，在新分支上把当前的模型选择范围（`mori.pick`）再记一次（§5.8；模型层规格加注；验收 FS-25）。
8. 嵌套 git 仓库不跟踪；右栏 This session 上方一行说明，列出这些路径（§5.3；验收 FS-26）。

**不做**：

- 不监视、不轮询：没有 `fs.watch`、`watchFile`、`setInterval`；git 状态只在事件发生时读，快照只在运行前后拍；没有后台清理、定时清理（proposal §9 第 5 条；§3.5、§4.7、§11.10）。
- 不做沙箱：命令分析认不出的写入（脚本、程序自己打开的文件）照常跑；MCP 与扩展工具在 Full access 下不分析（proposal §5.1；§7.5、§6.10）。
- 不自带 git，没装 git 时不另做一套不用 git 的快照与改动列表（proposal §9 第 7 条）。
- 不做 PR 流程、合并按钮、同步基础分支，不做 Claude 的 Worktree location、Branch prefix、`.worktreeinclude`、30 天自动清理，不按实例开 worktree（§11.12）。
- Rewind 不做 Summarize，Undo 之后不做 Redo（§5.5、§5.9）；仍不做你自己配置的按命令前缀放行（proposal §10）。
- 不兼容当前版本存下的数据：带 `readOnly` 的 `board.json`、工具被旧版本裁过的会话都打不开（上面第 1、2 条）；角色文件里写着 `tools:` 的按未知字段拒绝启动（§8.6）；
  载荷变了的录制（发给模型的文字、工具、批准请求的事件）重录，不给它们补默认值；回放桥只为会话信息里界面新加的字段补 synthetic 的空值（同 `teamInfo`，§14、§19.4）。

**已知的限制**（不另加机制）：

- 嵌套 git 仓库里的改动不进快照（上面第 8 条）。
- 工作路径里有还没有提交的嵌套 git 仓库时快照失败（git 不收它：`'<dir>/' does not have a commit checked out`），直到它有了提交或被加进 `.gitignore`（§4.4）。
- 在 pi 设置的默认工具（`defaultTools`）里加了工具之后，之前存下的会话恢复出来的工具缺这一项，按 §8.6 拒绝打开，提示仍是 “This session was saved by an older version of Mori and can’t be opened.”。
- 命令分析不是沙箱：程序自己写到别处看不到；MCP 与扩展工具在 Full access 下不分析。
- `.cmd` / `.bat` 垫片（npm、npx、tsc 等）的参数由 cmd.exe 再解析一遍，Mori 只按文字从严拦下含 cmd.exe 元字符的参数与 PowerShell 的 `--%`（file-system-permissions.md §7.4、§7.8）。
- 第一条消息还没写盘时 Mori 退出，已经建好的 worktree 留在磁盘上，设置页的 Clean up worktrees 列不出来（你自己 `git worktree remove`）。
- 后台进程重启时重建还没写盘的 worktree 会话（`app/src/renderer/src/state/projects.ts:281-301`），它没有 `mori.worktree` 条目，归档、删除时不再处理那个 worktree。
- 共用配置里有 `core.worktree` 的仓库（`git init/clone --separate-git-dir` 的旧写法或手工设置）不能建 worktree（§11.5.3）。
- 同时运行两个 Mori 实例（例如双击两次快捷方式）时两个后台进程共用快照目录，同一工作路径的快照会互相干扰（段的归属、`refs/mori/last`、启动时的陈旧锁清理），不另加机制；
  主进程没有单实例锁（`app/src/main` 里没有 `requestSingleInstanceLock`），与现有的会话、设置、TaskBoard 文件共用的问题相同。
- 工作路径里指向记忆目录（`<userData>/memory`）的链接或目录联接能绕过 mori-memory 的写保护（它按词法判断，记忆规格 §7.7）；路径闸按真实路径把这些写入归为工作路径外、照常出卡，不另加机制（2026-10-27 注：负责人定）。
- 工作路径很长（约 190 个字符以上）时拍不了快照：内部仓库的路径是快照目录加 `projectDirName` 编码，git 拒绝过长的 `--git-dir`（2.55 实测 `'$GIT_DIR' too big`、`Filename too long`，`core.longpaths` 也不行）；这时 `snapshots.error` 是 git 的原文，这个文件夹没有 code restore，git 状态照常（2026-10-27 注：负责人不在时按推荐定，待复核）。
- 重新打开被 §8.6 拒绝的旧会话时，pi 建立会话与选择范围的载入已经在会话文件末尾写了条目（pi 自己写，在检查之前），会话照样打不开（2026-10-27 注：负责人不在时按推荐定，待复核）。
- `git worktree remove --force --force` 中途失败（例如别的程序以那个文件夹为当前目录）时 git 已经删了登记、文件夹留着；之后 Clean up worktrees 把它当成 `Not a Mori worktree: <path>`，打开拥有它的会话报“在、但没登记”的原文，要你手动删掉那个文件夹（2026-10-27 注：负责人不在时按推荐定，待复核）。

## 1. 术语与代码名

| proposal 用语 | 本文与代码中 | 说明 |
| --- | --- | --- |
| 工作路径 | working directory；会话的 cwd（pi 的 `ctx.cwd`） | “里”“外”、`.work`、快照都以它为准；worktree 会话为它的 worktree（或其中的子文件夹，§11.2） |
| 主文件夹 | `projectFolder(cwd)`（`shared/workspace.ts`） | 按路径算，不调 git（§11.3）；侧栏分组、记忆、增强、反馈、模型的项目访问、`.mori/agents` 按它 |
| 工作区模块 | `kernel/git.ts`、`kernel/workspace.ts` | 找 git、运行 git、认仓库、git 状态、`.work`、worktree、Initialize git |
| 仓库信息 | `RepoInfo`（`toplevel`、`commonDir`、`gitDir`、`isWorktree`、`hasCommit`） | §3.4；不给主文件夹 |
| git 状态 | `WorkspaceStatus`；`workspace.status`、`mori.workspace_status` | §3.5；界面 Changes 的上半部分 |
| 快照模块 | `kernel/snapshots.ts`、`kernel/timeline.ts`（纯函数）、`kernel/rewind.ts` | §4、§5 |
| 内部仓库 | internal repo，`<snapshotsDir>\<编码>\` | 每个工作路径一个，在工作路径外（§4.1） |
| 快照 | snapshot：内部仓库里没有父提交的提交；状态 `SnapshotState` | 每次运行前后各一张（§4.4） |
| 快照作业、时间线 | job（按工作路径排队）；`Timeline`、`ActiveRun` | §4.5 |
| 段 | segment：相邻两张快照之间 | 记给当时在运行的用户会话（§4.5） |
| 一轮 | turn；记录里的 `round`（你的一条消息的条目 id） | 界面 `Turn <n>`（§5.3） |
| 一轮的改动 | `mori.turn_changes`：`RunRecord`（`kind: 'run'`）、`ChangesRecord`（`kind: 'changes'`） | §4.6 |
| 能恢复代码 | code restore：当前分支上有这条消息的 `run` 记录 | §5.5 |
| 保险快照 | safety snapshot P；恢复后快照 Q | §5.6、§5.7 |
| Rewind、冲突 | `rewind`、`rewind.undo`、`mori.rewind`（`RewindRecord`）、`RewindResult`；冲突 `changed`、`overlap` | §5.5–§5.11 |
| 右栏 Changes | `ChangesPanel.tsx`：`GitStatus.tsx` 与 This session（`SessionChanges.tsx`） | §5.1–§5.3 |
| 路径闸 | path gate：`mori-approval` 的 `tool_call` 处理器（`kernel/approval.ts`）+ `kernel/pathGate.ts` | 判断顺序 §6.1 |
| 调用种类 | `callKind`：`duty`、`read`、`file`、`command`、`other` | §6.2 |
| 目标的归类 | `inside`、`work`、`protected`、`outside`；看不出的 `unresolved`、换到外面的 `leaves`、分析不了的 `unanalyzed` | §6.4 |
| scope | `ApprovalScope = 'inside' \| 'outside' \| 'protected'`；`ApprovalTarget` | 后台进程判定，界面不猜（§6.13） |
| 受保护路径 | `PROTECTED_DIRS`、`PROTECTED_FILES` | §6.5 |
| 权限模式 | `ApprovalMode = 'ask' \| 'full'`：Ask each time / Full access | §6.7 |
| Allow for this session | 按工具名 `ApprovalPolicy.allowed`；按目录 `ApprovalPolicy.allowedDirs`、决定 `allowDir`、请求上的 `allowDirs` | §6.8、§6.9 |
| 没人能批 | `new ApprovalPolicy({ mode: 'full', canAsk: false })` | 增强会话与它的实例（§6.11） |
| 命令分析 | `kernel/commandScan.ts` 的 `scanCommand`：`ScanInput`、`ScanResult`、`ScanWrite`、`ScanLeave`、`UnknownWhy` | §7.2；纯函数 |
| 换到工作路径外 | leave（`ScanLeave`）：每一次换目录之后运行的非只读命令都报告，§6 按真实路径丢掉仍在里面的 | §7.7 |
| 只读命令 | `READ_ONLY_COMMANDS` | 只用于 leave（§7.7） |
| `.work` | `WORK_DIR`；`ensureWork`、`workTmp`、`workVars`、`workEnv`、`shellTools` | §7.10、§7.11 |
| 收窄 | narrowing：`Limits`（工具参数 `limits`）、`Narrowing`、`NarrowingOwner`，`kernel/limits.ts` | §8 |
| 程序给的收窄 | `PROGRAM_LIMITS`（`{ write: false }`）、`TEAM_DIALOG_LIMITS`（`{ write: false, mcp: false }`） | §8.3 |
| 按职责给的工具 | duty tools：`DUTY_TOOLS`（TaskBoard 工具、`memory`、`ask_user_question`；2026-10-27 注：收尾检查落地后另有 `finish`，见 [finish-check.md](finish-check.md) §11；合并 subagent 那条线后另有普通模式的 `subagent`，关闭模式的运行由 `applyDutyTools` 启用、增强会话没有，见 docs/v1/walkthrough-1026-checks.md 的 U52） | 免批准、不收窄（§6.2、§8.6） |
| 写 task | `writesFiles(task)`：`limits.write` 不是 false | 取写入锁（§8.7） |
| 你不在、无人应答模块 | away；`kernel/away.ts` | §9 |
| 时长 | `AwayTimeout = '60s' \| '5m' \| '10m' \| 'never'`；`<userData>/away.json` | 设置 When you’re away（§9.6） |
| 自动处理记录、提醒 | `mori.away_decision`（`AwayDecision`）；`mori.away_reminder`（`custom_message`） | §9.7、§9.8 |
| 提问工具、提问卡 | `ask_user_question`，扩展 `mori-question`，`kernel/askQuestion.ts`；`AskQuestion`、`AskAnswer`；`AskCard.tsx` | §10 |
| worktree 会话 | 拥有 worktree 的会话：`mori.worktree` 条目、`SessionInfo.worktree` | §11.6 |
| Mori worktree | `<R>/.mori/worktrees/<名字>`，分支 `mori/<名字>`；`worktreeOf(cwd)` | §11.2、§11.3 |
| Initialize git、Clean up worktrees | `workspace.initGit`；`worktrees.list`、`worktrees.cleanUp` | §11.9–§11.11 |
| 程序拒绝的开头 | `DENIAL_PREFIXES`（`shared/workspace.ts`） | 界面据此显示 Denied（§12） |

## 2. 组件与代码落点

文件相对 `app/src/`，新文件标（新）。每个文件不超过 2000 行，每个函数不超过 50 行、不超过 5 个入参（AGENTS.md）。
`kernel/sessions.ts`（1622 行）只加调用，逻辑放进下面的新文件；§11.5.4 的 `startInWorktree` 放在新文件 `kernel/worktreeSession.ts`，sessions.ts 把内部的 `closeEntry`、`startUser` 作为参数传给它（单元测试据此注入会抛错的 `startUser`，FS-100）；`kernel/team.ts`（1679 行）删掉的比加的多；`kernel/modelSession.ts`（1651 行）只加一个入口；三者改完都不超过 2000 行。

| 组件 | 文件 | 做什么 |
| --- | --- | --- |
| 工作区模块 | `kernel/git.ts`（新） | 找 git（含测试用的 `MORI_GIT_PATH`）、运行 git：不经 shell、环境副本（去掉 `GIT_*`）、内部仓库的隔离配置（含写出 `gitconfig`）与固定 `-c`、超时、输出上限、按键排队；`spawn` 与找 git 的候选从模块参数传入（单元测试注入替身）；从不改 `process.env`（§3.2、§3.3） |
| 重建 worktree 会话 | `kernel/worktreeSession.ts`（新） | `startInWorktree`：记下要沿用的设置、关掉旧的、按原 id 在 worktree 里建会话并写 `mori.worktree`、用传入的 `startUser` 带原来的 `ApprovalPolicy` 启动、按顺序设回设置；失败时撤掉 worktree 与分支并在原文件夹重建（§11.5.4、§11.5.7） |
| 工作区模块 | `kernel/workspace.ts`（新） | `repoInfo`、`status`（解析用 `timeline.ts`；500 条、去抖、同一时刻一个、发给同路径的用户会话）（§3.4、§3.5）；`.work`：`WORK_DIR`、`workTmp`、`workVars`、`workEnv`、`ensureWork`、`shellTools`（§7.10、§7.11）；`worktreeName`、`createWorktree`（含失败的清理）、`restoreWorktree`、`listWorktrees`、`cleanUpWorktrees`、按行读会话文件里的 `mori.worktree`、`initGit`（§11） |
| 快照模块 | `kernel/snapshots.ts`（新） | 内部仓库与归属、快照作业与 `SnapshotState`（含嵌套仓库）、按工作路径的队列与时间线、inline extension `mori-snapshots`、`mori.turn_changes`、ref 与整理、`snapshots.diff`、`snapshots.drop`（§4、§5.3） |
| 快照模块 | `kernel/timeline.ts`（新，纯函数） | 段的归属与轮的解析、porcelain v2 解析、`info/exclude` 的生成与转义、`--raw --numstat` 解析、文件集合与冲突、保留时选出要删的轮（单元测试直接喂数据） |
| 快照模块 | `kernel/rewind.ts`（新） | Rewind 与 Undo：检查、保险快照、恢复、`navigateTree`、再记一次 `mori.pick`、`mori.rewind`、协作模式的需求检查（§5.5–§5.10）。`snapshots.ts` 放不下它们，所以与 `timeline.ts` 分开 |
| 路径闸 | `kernel/pathGate.ts`（新，纯函数；只有 `realTarget` 碰文件系统，`lstat`、`realpath` 从参数传入） | 从 `app/src/kernel/memoryExtension.ts:129-182` 移来的 `resolveToCwd`、`insideDir`（改照 pi 的 `getCwdRelativePath`，导出给 `limits.ts`）；另导出“是不是同一个路径”的比较（`path.win32.relative` 为空，不分大小写、统一 `/` 与 `\`），给 `commandScan.ts` 判断当前目录是不是工作路径本身（§7.2）；`realTarget`；段名比较；`PROTECTED_DIRS`、`PROTECTED_FILES`；`classifyTarget`（含 `remove`、`into`）、`callKind`、`classifyCall`（命令调 `commandScan.ts`，最多 100 个目标）；`DUTY_TOOLS`（§6.2–§6.5；2026-10-27 注：含收尾检查的 `finish`，见 [finish-check.md](finish-check.md) §11） |
| 路径闸 | `kernel/approval.ts` | `gateFor(toolName)` 换成按 §6.1 判断顺序的 `decide(call)`；`ApprovalPolicy`：构造选项 `{ mode?, canAsk? }`、`allowedDirs`、`allowDirs(dirs)`、`forgetDir(dir)`、`promptMode()`、`setMode('full')` 只放行 scope `inside` 的挂起请求；`ApprovalGate`：`Pending` 记 scope、targets、allowDirs，`requests()` 带上，`answer` 处理 `allowDir`，`announce` 带 `args`，更正规则，停止中只放过 `duty`、`read`，分类出错的处理，放行命令与写 `.work` 之前 `await ensureWork`；`GateOutput` 加 `cwd`、`narrowing`、`userSessionId`、`handedOff`、`kind`；发出请求事件之后向 `away.ts` 登记（带 `kind`）、结束时注销，到时按 `'away'` 拒绝；工厂加 `agent_before_settle` 处理器；`FREE_TOOLS` 拆成 `DUTY_TOOLS` 与 `READ_ONLY_TOOLS`；文件头注释改写（§6、§7.10、§8.5、§9） |
| 命令分析 | `kernel/commandScan.ts`（新，纯函数） | `scanCommand` 与类型；两种 shell 的词法与语法、前缀与嵌套、写法表、`READ_ONLY_COMMANDS`、路径解析、换目录规则、上限常量；超过 2000 行时拆出 `commandScanBash.ts`、`commandScanPs.ts`，入口不变（§7） |
| 收窄 | `kernel/limits.ts`（新，纯函数，不载入 pi） | `Limits`、`NO_LIMITS`、`PROGRAM_LIMITS`、`TEAM_DIALOG_LIMITS`、`Narrowing`、`parseLimits`、`askLimits`、`limitsText`、`checkLimits`（§8.2–§8.4） |
| 无人应答 | `kernel/away.ts`（新） | 焦点、时长与 `away.json`、登记与计时（可注入的时钟、`MORI_AWAY_TIMEOUT_MS`）、`mori.away_timer`、到时之后的记录、按会话的提醒清单与 `reminder()`（§9） |
| 无人应答 | `kernel/extensionUi.ts` | `ask` 在发出 `mori.ui_request` 之后登记、`finish` 注销；到时按取消结束并记录（§9.4） |
| 提问 | `kernel/askQuestion.ts`（新） | inline extension `mori-question`、工具定义与说明、执行时校验、挂起的提问 `ask-<n>`、答复与拒绝、停止与关闭、交给 `away.ts`、结果原文、分开时的转发回调（§10） |
| 会话 | `kernel/sessions.ts` | 注册 `mori-snapshots`（必需，`mori-approval` 之后、`mcp` 之前）与 `mori-question`（只在用户会话、不是看不见的会话；mori-memory 之后、mori-approval 之前；不是必需）；`createEntry` 传 `cwd`、建 gate 时加 `kind`（`{ ...setup.gate, kind: setup.kind, send }`，§9.2）、`customTools: shellTools(pi, args.cwd, setup.settings)`；`forward` 的 `announce` 传 `event.args`、`agent_settled` 时清提醒清单；增强会话的 `userApproval` 为 `{ mode: 'full', canAsk: false }`；`startUser` 的 gate 带 `narrowing`、`userSessionId`；重新打开时在 `refreshTools` 之前检查恢复出来的工具，缺 pi 默认工具时拒绝打开（§8.6；`refreshTools` 本身不变）；`forgetApproval` 收 `{ toolName } \| { dir }`；快照模块的登记与注销、`settleRun`、`stopRun`（快照、提问；在 `rejectForStop` 之后、`session.abort()` 之前通知快照模块）、`release`（`await session.abort()` 之前先通知快照模块结束这个会话等着的开始快照作业，§4.5）、正在 Rewind 时 `prompt` 拒绝、`shutdownSessions` 后等队列、Rewind 用的 `navigateTree`；`snapshot` 加 `awayTimers`、`asks`；`liveStatus` 计入提问；`answerAsk`；导出 `record`；`promptEntry` 遇 `worktree` 走 `startInWorktree`、`creatingWorktree`、`UserStart.approval`、`Entry.worktree`、`describeEntry`、`openFromFile` 先恢复 worktree |
| 会话 | `kernel/commands.ts` | `workspace.status`、`snapshots.diff`、`snapshots.drop`、`rewind`、`rewind.undo`、`approval.forget` 的两种参数、`away.get`、`away.set`、`question.answer`、`workspace.initGit`、`worktrees.list`、`worktrees.cleanUp`；`session.prompt` 传 `worktree` |
| 会话 | `kernel/index.ts` | `start` 消息的 `snapshotsDir` 与 `startAway`；`window_focus`（调 `away.setFocus`、记日志）；`shutdown` 时等快照队列 |
| 会话 | `kernel/instances.ts`、`kernel/resources.ts` | `instanceSetup` 把 `narrowing`、`userSessionId: spec.owner`、Team 给的 `handedOff` 放进 gate；`toolSource` 把 `source === 'sdk'` 算内置（导出给单元测试）、`<inline:mori-question>` 写 Mori（§7.11、§10.1） |
| 记忆 | `kernel/memoryExtension.ts`、`kernel/memoryText.ts` | 路径解析改 import `pathGate.ts`；`MemoryExtensionSetup` 加 `permission()`；`IDENTITY_TEXT` 换成 `identityText(permission)`（三种权限句与 `.work` 一行，§6.16、§7.12） |
| 记忆 | `kernel/memory.ts`、`kernel/memoryFiles.ts`、`kernel/enhanceRun.ts`、`kernel/feedbackRead.ts`、`kernel/memoryAssemble.ts` | 项目目录、占用检查、`claimProject`、`otherProjects`、`mori.memory_changed` 的 `cwd`、增强与反馈的比较都先取 `projectFolder`（§11.7）；`memoryAssemble.ts` 的注释改为“含 `write: false` 的 task” |
| 模型层 | `kernel/modelLayer.ts`、`kernel/modelSession.ts` | `registerProject`、`projectContext`、`projectAccess` 先取 `projectFolder`（§11.7）；`modelSession.ts` 加一个入口，在当前叶子之后再记一条 `mori.pick`（同 `:795` 的 `writeEntry`），给 `rewind.ts` 用（§5.8） |
| TaskBoard | `kernel/team.ts` | 删 `teamEdited`（`boardEdited`、`instancesEdited`、`:1220-1222`），给 `mori-snapshots` 提供实例的角色与 task、对话持有者的角色，Rewind 用的 `busy()`（§5）；`Lane.limits` 的来源、`narrowingFor`、`userNarrowing`、`instanceTools`、`applyDialogTools` → `applyDutyTools`（不动 `ask_user_question`）、`userToolNames`、`guardCall` 去掉用户会话的分支、去掉 `UserRunStart.allowed`、`offRestore`、`lastOffTools`、`wasTeamActive`、`mori.team` 的 `tools`（§8）；`onApprovalEnd` 在 `by === 'away'` 时写 `mori.away_decision`、给实例 gate 的 `handedOff`（§9）；提问结束时转给立项、`wakeCreateForTask` 带选项（§10） |
| TaskBoard | `kernel/teamView.ts`、`teamLanes.ts`、`teamRuns.ts`、`teamHost.ts` | 删 `teamEdited` 的计算；`Lane.readOnly` → `limits`、去掉 `LaneRun.allowed`；`runStarted` 不再抄 `allowed`、`ask_user` 投递取 task 最后一棒的选项；`InstanceSpec.narrowing`、`TeamLike.userNarrowing()`、`tools`/`baseTools` 的注释 |
| TaskBoard | `kernel/teamTypes.ts`、`kernel/board.ts` | `LimitsSchema`（`z.strictObject`，各项 `z.literal(false).optional()`、`writePaths` 1–10 项）；`BoardTaskSchema` 的 `readOnly` 换成**必填**的 `limits`（§0 写规格时定的第 1 条）；`HandoffSchema`、`HandoffInput` 加可选的 `options`、`recommended`，`handoffFieldsError` 校验；`CreateTaskInput.limits`，`createTask` 总写 `limits`（没有限制为 `{}`）；`MessageRoute` 的 `ask` 注释去掉“只读” |
| TaskBoard | `kernel/boardTools.ts`、`teamTools.ts`、`teamFlow.ts`、`boardRoute.ts`、`boardText.ts`、`handoffForm.ts`、`roles.ts` | `task_create`、`agent_message` 的 schema、说明与 Correct form，`prepareToolArgs` 归一 `limits` 的键名；`parseLimits`、`askLimits` 的接线、`relay` 的选项、`task_handoff` 读选项；`forwardAnswer`；`writesFiles(task)`；`limitsText` 与 §14 的各段、选项行；交接 schema 与 `checkForm`；去掉 `tools` 字段与按工具开关的函数、`instanceTools`、`loadRoles` 用 `projectFolder`（§8、§10、§11.7） |
| 进程桥 | `shared/workspace.ts`（新） | 本规格的类型与 zod schema：§3–§5（`RepoInfo`、`WorkspaceStatus`、`SnapshotState`、`RunRecord`、`ChangesRecord`、`RewindRecord`、`RewindResult`）；§8（`NarrowingOwner`、`NARROWING_LEADS`、从 `app/src/kernel/team.ts:64` 移来的 `RELAY_ONLY`）；§9（`AwayTimeout`、`AwayDecision`、`away.*`）；§10（`AskQuestion`、`AskAnswer`、`question.answer`、`ASK_DECLINED_TEXT`、`ASK_STOPPED_TEXT`）；§11（`worktreeOf`、`projectFolder`、`refsInto`、`WORKTREE_ENTRY_TYPE`、`WorktreeEntrySchema`、`WorkspaceCommandSchemas`）；`REJECTED_AWAY_PREFIX`、`DENIAL_PREFIXES`（§12） |
| 进程桥 | `shared/protocol.ts`、`shared/team.ts` | `ApprovalMode`、`ApprovalState`、`DEFAULT_APPROVAL`、`APPROVAL_DECISIONS`、`approval.*` 的 schema、`ApprovalRequestInfo`、`mori.approval_request`、`ToolGate`、`ApprovalEndBy`、`ApprovalScope`、`ApprovalTarget`；`session.prompt` 的 `worktree`、`SessionInfo.worktree`、`LiveSnapshot.awayTimers`、`asks`；`KernelEvent`、`CommandSchema` 并入 `shared/workspace.ts` 的命令与事件；`shared/team.ts`：删 `BoardView.teamEdited`、`TeamApprovalRequest` 加三个字段、`TeamEntrySchema` 去掉 `tools` |
| 主进程 | `main/kernel-process.ts`、`main/index.ts` | 读 `MORI_SNAPSHOTS_DIR` / `LOCALAPPDATA` 放进 `start`（§4.1）；窗口的 `focus`、`blur`、`minimize`、`restore` 算焦点、只在变化时发 `window_focus`，`connectWindow` 补发一次（§9.1） |
| 界面 | `renderer/src/components/ChangesPanel.tsx`（重写）、`GitStatus.tsx`（新）、`SessionChanges.tsx`（新）、`FileViewer.tsx`、`App.tsx` | 右栏 Changes、阅读器重读的依据、自动打开（§5.1–§5.3） |
| 界面 | `components/ChatPane.tsx` | 顶栏 `+N −M` 与 `Toggle changes` 的悬停文字（§5.1、§5.4）；提问卡与扩展询问卡按到达顺序排（§10.4）；顶栏项目名、增强提示的 View 取 `projectFolder`（§11.7） |
| 界面 | `components/Transcript.tsx`、`RewindMenu.tsx`（新）、`RewindDialog.tsx`（新）、`AwayBlock.tsx`（新） | 消息上的 Rewind、菜单、冲突对话框、通知与 Undo、进行中（§5.5–§5.10）；一轮末尾的 Decided while you were away（§9.9） |
| 界面 | `components/ApprovalCard.tsx`、`approvalLabel.ts`、`PermissionMenu.tsx`、`ToolCard.tsx`、`toolTitle.ts`、`IssueDialog.tsx`、`ConfirmDialog.tsx` | 删 `outsideFolder`，按 `targets` 显示原因行，Alt+2 换成 `allowSession` / `allowDir` / 无，第二个按钮与小字，倒计时一行；模式 `ask` / `full`、悬停说明、确认框、目录项与 Forget；工具卡标签、`Ask · <headers>`、`Waiting for your answer`；F8 的 `Full access`；注释（§6.13、§6.14、§9.9、§10） |
| 界面 | `components/QuestionCard.tsx`、`AskCard.tsx`（新）、`StageLine.tsx` | 提问卡、倒计时、阶段行 `Waiting for your answer` 与 `Creating worktree…`（§9.9、§10.4、§11.5.6） |
| 界面 | `components/SettingsPage.tsx`、`settings/GeneralSection.tsx`（新）、`settings/StorageSection.tsx`（新） | `General`（When you’re away，§9.6）与 `Storage`（Clean up worktrees，§11.10）两节 |
| 界面 | `components/WorktreeToggle.tsx`（新）、`Composer.tsx`、`InitGitDialog.tsx`（新）、`icons.tsx`、`sessionRows.ts`、`SessionTree.tsx`、`SessionEdits.tsx`、`BlockedCard.tsx` | Worktree 开关与 Initialize git…、确认框、图标 `branch`；按主文件夹分组、分支标签、删除确认框的 worktree 一句、allow_zone 的项目路径（§11.4、§11.7、§11.9、§11.11） |
| 界面 | `state/history.ts`、`state/model.ts`、`state/transcript.ts` | 读 `mori.turn_changes`、`mori.rewind`、`mori.away_decision` 条目与事件；`PendingApproval` 加 `scope`、`targets`、`allowDirs`，`allowedBy` 为 `'session' \| 'dir' \| 'full' \| null`，`parseRejection` 认 `DENIAL_PREFIXES`；挂起的卡带 `deadline`；提问的挂起与工具卡状态；不出卡的程序拒绝记为 `rejected` 并清掉 `allowedBy`（§6.15）；`mori.snapshot_stage` 的阶段行（§13）；`turnNumbers`（`state/sessionRefs.ts` 的 `sessionTurns` 也用它，§5.3） |
| 界面 | `state/workspace.ts`（新）、`state/rewind.ts`（新）、`state/worktrees.ts`（新）、`state/store.ts` | 每个会话的 `WorkspaceStatus` 与刷新时机、This session 的归组、Rewind 菜单的可用性与调用（§5）；开关、Initialize git、清理的动作，`Tab.worktreeOn`、`Tab.creatingWorktree`（§11） |
| 界面 | `state/actions.ts`、`state/projects.ts`、`state/actionLog.ts`、`state/settings.ts`、`state/trust.ts`、`state/memory.ts` | 删除会话后 `snapshots.drop`、Rewind 后 `putBackQuoted`；`setApprovalMode`、`forgetApproval`；`mori.question_request` 时 `requestAttention`；`send()` 带 `worktree`、`refsInto`、`markFailed`（改成导出）；归档、删除调 `worktrees.*`；操作记录（§12）；When you’re away；本次信任回答与记忆页跟随按 `projectFolder` |
| 界面 | `styles/chat.css`、`styles/tokens.css` | `.permission-button.all` → `.full`；`:358` 的 `margin-left: auto` 移到开关后面那一项，≤ 460px 时开关只剩图标；注释里的 “Allow all” 改 “Full access” |
| 存放 | `%LOCALAPPDATA%\Mori\snapshots\`、`<工作路径>/.work/`、`<R>/.mori/worktrees/<名字>`、`<userData>/away.json` | 内部仓库（§4.1）、草稿与临时文件（§7.10）、worktree（§11.2）、你不在的时长（§9.6） |

## 3. git 与工作路径：找 git、认仓库、git 状态

本节是 proposal §3“git 是系统的 git”、§4“没装 git / 不是 git 仓库”、§7 的 `workspace.status`、§8“git 状态什么时候读”的实现。
屏幕状态表见 [fs-changes.md](../v1/screens/fs-changes.md)。

### 3.1 现在怎样

- `app/src` 里没有任何 git 调用，也没有 `child_process`（只有主进程的 `utilityProcess.fork`，`app/src/main/kernel-process.ts:42`）；提到 git 的只有注释和提示词。
- pi 里能读分支的只有 TUI 的 `FooterDataProvider`：它用 `fs.watch` 盯 HEAD 所在的目录，在 WSL 里看 Windows 盘上的仓库时另用 `fs.watchFile` 轮询
  （`app/node_modules/@earendil-works/pi-coding-agent/dist/core/footer-data-provider.js:79-81`、`:285-327`），违反“不监视、不轮询”，Mori 不用它。
  pi 的 `findGitPaths`（同文件 `:9-39`）没有导出（包的 exports 只有 `.` 和 `./rpc-entry`），Mori 也不抄它，改为问 git（§3.4）。
- pi 的 `pi.exec` 只有 `signal`、`timeout`、`cwd`，没有 `env`（`app/node_modules/@earendil-works/pi-coding-agent/dist/core/exec.d.ts:7-14`），给不了内部仓库要的隔离环境。所以 git 一律由 Mori 在后台进程里自己起进程（§3.3）。
- 右栏现在只列对话流里成功的 `edit`、`write`（`app/src/renderer/src/components/ChangesPanel.tsx:23-38`），顶部注明命令改的不在内（`:79`）；
  后台实例改过文件时另有一句 `Changes made by team tasks aren’t listed here.`（`:67`、`:75-76`，来源 `BoardView.teamEdited`）。§5 整个替换它们。

### 3.2 找 git（`kernel/git.ts`）

0. 环境变量 `MORI_GIT_PATH` 有值时（测试用，照 `MORI_USER_DATA` 的写法，§17）只试这一个路径：文件不存在就是 `missing`，不再看下面的位置。
1. 依次找：`process.env.PATH` 里每个目录下的 `git.exe`（只看文件是否存在，不起进程）；然后 `C:\Program Files\Git\cmd\git.exe`。第一个存在的就是它。
   候选列表与起进程的 `spawn` 从模块参数传入（默认就是上面这些与 `node:child_process.spawn`），单元测试据此注入替身（FS-01、FS-02）。
2. 找到后跑一次 `git --version`（§3.3 的方式，5 秒），解析 `git version X.Y.Z…`：
   - 版本 ≥ 2.32（`GIT_CONFIG_GLOBAL` 从 2.32 起，§3.3 内部仓库的隔离靠它，Git for Windows 的 RelNotes 2.32.0；`rev-parse --path-format` 2.31、`restore` 2.23、`--pathspec-from-file` 2.26 都更早）→ `{ state: 'ok', path, version }`；
   - 更低 → `{ state: 'old', version }`；
   - 没找到、或 `--version` 失败、超时 → `{ state: 'missing' }`（失败原文写日志）。
3. 结果在后台进程里记住。`ok` 一直用到后台进程退出；`missing`、`old` 时，每次 `workspace.status` 命令（打开、切换会话、点 Refresh，§3.5）都再找一次，
   所以装好 git 后点 Refresh 就能用，不用重启。别的地方不重找。
4. `ok` 以外的状态下：git 状态、快照、This session、Rewind 都不可用（proposal §9 第 7 条），界面按 §5.1 说明；不另做一套不用 git 的做法。

### 3.3 运行 git（`kernel/git.ts`）

```ts
/** @brief 一次 git 调用。 */
interface GitRun {
  /** git 之后的参数（不含 git 本身）；-c 与 --git-dir 等全局选项由调用方按下面的规则放在最前 */
  args: string[];
  /** 进程的工作目录 */
  cwd: string;
  /** 排队的键：同一个键同一时刻只有一个 git 进程（用户仓库用仓库根，内部仓库用它的目录） */
  key: string;
  /** 内部仓库的调用（§4.2）：用隔离的配置；用户仓库的调用省略 */
  isolated?: boolean;
  /** 写进 stdin 的内容（--pathspec-from-file=-）；没有时 stdin 关掉 */
  stdin?: Buffer;
  /** 超时（毫秒），到时结束进程 */
  timeoutMs: number;
  /** stdout 的上限（字节），超过时结束进程 */
  maxOutput: number;
}
/** @brief 结果；进程起不来时 code 为 null、error 为原文。 */
interface GitResult { code: number | null; stdout: Buffer; stderr: string; timedOut: boolean; truncated: boolean; error: string | null }
```

- **进程**：`child_process.spawn(gitPath, args, { cwd, env, windowsHide: true, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] })`（找到的是 Git for Windows 的启动器 `<安装目录>\cmd\git.exe` 时，内部仓库的调用直接起它旁边真正的 git，`mingw64\bin\git.exe` 等按架构找；你的仓库的调用照旧用启动器（2026-10-27 注：负责人不在时按推荐定，待复核））。不经 shell，参数原样传，
  路径、pathspec 里有空格、引号、中文都不用转义。Windows 命令行有 32K 字符的上限，路径可能很多时：
  - `add`、`restore` 用 `--pathspec-from-file=- --pathspec-file-nul` 经 stdin 传；
  - `diff`、`ls-files`、`ls-tree` 不认这个选项（本规格复核时在 2.55 上实测：`unknown option`），改为不带 pathspec 列全、在 Mori 里取交集；
    只有 §4.4 第 4 步的大文件候选作参数传，每批命令行不超过 30000 字符。

  `spawn` 从模块参数传入（默认 `node:child_process.spawn`）：FS-01、FS-02 的替身进程与 FS-03、FS-06 的失败用例据此注入（§19.1）。
- **环境**：`process.env` 的副本，去掉所有以 `GIT_` 开头的变量（不分大小写），再加 `LC_ALL=C`（git 的提示固定英文，§3.4 要按原文判断“不是仓库”）、
  `GIT_TERMINAL_PROMPT=0`。内部仓库的调用另加 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=<快照目录>\gitconfig`（§4.1）。
  **从不改 `process.env`**：否则 pi 的 bash、PowerShell 工具和 MCP 服务都会继承这些变量（proposal §3）。
- **内部仓库的固定选项**（放在子命令之前，每次都带）：`--git-dir=<内部仓库> --work-tree=<工作路径> -c gc.auto=0 -c maintenance.auto=false
  -c core.longpaths=true -c core.autocrlf=false -c core.quotepath=false`。`gc.auto=0` 避免 u-a8 实测的 54 秒自动 gc 卡顿；整理只在删除会话时做（§4.7）。
  用户仓库的调用不带这些 `-c`，用你自己的配置（git 状态要和你在终端里看到的一样）。
- **超时与上限**（§17）：`--version` 5 秒；`rev-parse`、`status`、给界面的 `diff` 10 秒；快照、恢复里的每个 git 进程 120 秒；删除会话时的 `prune` 300 秒。
  stdout 上限：`status` 4 MB，其他 16 MB；stderr 只留前 64 KB。超时或超过上限时结束进程（Windows 上用 `taskkill /F /T /PID <pid>` 结束整棵进程树：Git for Windows 的 `cmd\git.exe` 只是启动器，只结束它时真正的 git 还在跑、拿着内部仓库的 `index.lock`；taskkill 起不来时退回 `child.kill()` 并记日志；等 `close` 的 2 秒宽限从 taskkill 退出时（最多等 10 秒）算起；Mori 结束的进程结果的 `code` 为 null（2026-10-27 注：负责人不在时按推荐定，待复核）），结果标 `timedOut` / `truncated`，记一行错误日志
  `[kernel] git <子命令> timed out after <n> ms in <cwd>`。
- **排队**：按 `key` 排队，同一个键同一时刻只跑一个 git 进程，先到先跑；不同的键并行。用户仓库的键是仓库根（`--show-toplevel`，没有仓库时用工作路径），
  内部仓库的键是它的目录。
- **错误**：`code !== 0` 时调用方用 stderr 的第一行非空文字作为原文（去掉开头的 `fatal: `、`error: `）；进程起不来时用 `error`。

### 3.4 认仓库（`workspace.repoInfo(cwd)`）

```ts
/** @brief 工作路径所在的 git 仓库；不是 git 仓库时整个为 null。 */
interface RepoInfo {
  /** 仓库根（--show-toplevel，绝对路径，反斜杠） */
  toplevel: string;
  /** 共用的 .git 目录（--git-common-dir） */
  commonDir: string;
  /** 这个 worktree 自己的 git 目录（--git-dir）；不是 worktree 时等于 commonDir */
  gitDir: string;
  /** 是链接出去的 worktree（gitDir !== commonDir） */
  isWorktree: boolean;
  /** 有没有提交（HEAD 指向一个提交） */
  hasCommit: boolean;
}
```

1. 在工作路径里跑 `git rev-parse --path-format=absolute --show-toplevel --git-common-dir --git-dir`（用户仓库的方式，10 秒）。三行依次是三个路径（换成反斜杠）。
2. 退出码 128 且 stderr 含 `not a git repository`（`LC_ALL=C`，§17）→ 不是 git 仓库，`repo: null`。
   其他失败（例如 `detected dubious ownership`、工作路径不存在）→ 不是“不是仓库”，而是错误：`WorkspaceStatus.error` 为原文，界面照 §5.1 显示。
3. 是仓库时再跑 `git rev-parse --verify --quiet HEAD^{commit}`：退出码 0 为 `hasCommit: true`。
4. 工作路径可以是仓库的子文件夹（例如打开的是 `repo/app`）：`toplevel` 是仓库根；git 状态列整个仓库（§3.5），快照只拍工作路径（§4.2）。
5. `RepoInfo` 不给主文件夹：按主文件夹算项目一律用 §11.3 的 `worktreeOf` / `projectFolder`（按路径和 `mori.worktree` 条目，不调 git）。
6. 不缓存：每次 `status` 都重新认（两个 `rev-parse` 在本机共约 0.15 秒，起草时实测），因为你随时可能 `git init`、删 `.git`、或 Initialize git（§11）。

### 3.5 git 状态（`workspace.status`）

**读法**：`repoInfo` 之后，在工作路径里跑 `git --no-optional-locks status --porcelain=v2 --branch -z`（用户仓库的方式，10 秒，stdout 4 MB）。
`--no-optional-locks` 让它不去刷新、写回你的 index，不和你自己的 git 抢 `index.lock`（git-status 文档）。未跟踪文件按你配置的默认（`normal`：整个未跟踪的目录显示成 `dir/`）。
不是 git 仓库、没装 git 时不跑。实测本机 Mori 仓库 0.11–0.13 秒（u-a8；本规格起草时复测 0.13 秒）。

**解析**（porcelain v2，`-z`，每条以 NUL 结尾）：

| 行 | 用到的字段 | 进 |
| --- | --- | --- |
| `# branch.oid <oid>` / `(initial)` | 提交；`(initial)` 为还没有提交 | `branch.oid`（null） |
| `# branch.head <name>` / `(detached)` | 分支名 | `branch.head`（detached 为 null） |
| `# branch.upstream <name>` | 上游 | `branch.upstream` |
| `# branch.ab +<a> -<b>` | 领先、落后（只有上游在本地存在时 git 才给） | `ahead`、`behind`；有上游却没有这一行为 null（上游已不在） |
| `1 <XY> … <path>` | X 是暂存区的状态、Y 是工作区的状态，`.` 表示没变 | X 不是 `.` → `staged` 一条（code = X）；Y 不是 `.` → `unstaged` 一条（code = Y）；同一个文件可以两条都有 |
| `2 <XY> … <score> <path>` NUL `<origPath>` | 重命名、复制 | 同上，`from` 为原路径 |
| `u <XY> … <path>` | 未合并 | `conflicted` 一条（code `U`） |
| `? <path>` | 未跟踪 | `untracked` 一条（目录以 `/` 结尾） |

- 路径是**相对仓库根**的（porcelain 不管 `status.relativePaths`；本规格起草时在 `app/` 子文件夹里复测，输出仍是 `AGENTS.md`、`app/package.json`），分隔符 `/`。
- 最多留 500 条（§17），`total` 是全部条数；stdout 超过上限时只解析到最后一个完整的 NUL，`total` 记已解析的条数，`truncated` 为真。
- 超时、失败：`error` 为原文，`files` 为空；分支信息也不给。

**载荷**（`shared/workspace.ts`）：

```ts
/** @brief 右栏上半部分与快照状态的来源（mori.workspace_status 与 workspace.status 的结果）。 */
interface WorkspaceStatus {
  /** 工作路径 */
  cwd: string;
  /** git 程序：ok 带版本；old 是版本太低；missing 是没找到 */
  git: { state: 'ok' | 'old'; version: string } | { state: 'missing' };
  /** 所在仓库；不是 git 仓库、git 不是 ok 时为 null */
  repo: RepoInfo | null;
  /** 分支（git status 的 # branch.* 行）；没有仓库或读失败时为 null */
  branch: { head: string | null; oid: string | null; upstream: string | null; ahead: number | null; behind: number | null } | null;
  /** 未提交的文件，最多 500 条 */
  files: { path: string; from: string | null; group: 'staged' | 'unstaged' | 'untracked' | 'conflicted'; code: string }[];
  /** 全部条数 */
  total: number;
  /** 输出超过上限，只解析了一部分 */
  truncated: boolean;
  /** 认仓库或 git status 失败的原文；没有为 null */
  error: string | null;
  /** 这个工作路径的快照状态（§4.4） */
  snapshots: SnapshotState;
  /** 读完的时刻（ms） */
  at: number;
}
```

**什么时候读**（proposal §8 的五个时机，加上 Rewind 之后）：

| 时机 | 谁发起 | 怎么读 |
| --- | --- | --- |
| 打开会话、切到会话 | 界面：`session.open` / `session.create` 成功后、焦点会话改变后发 `workspace.status { sessionId }` | 立即 |
| 改文件的工具执行完 | 后台进程：用户会话和它的实例的 `tool_execution_end`，工具不是 §6.2 的 `duty`、`read` 两种（现在的 `FREE_TOOLS`，`app/src/kernel/approval.ts:27`，由 §6.2 拆成 `DUTY_TOOLS` 与 `READ_ONLY_TOOLS`，含 §10 的 `ask_user_question`），即 edit、write、命令、MCP 与扩展工具 | 这个工作路径去抖 500 毫秒（最后一次之后 500 毫秒才读） |
| 一轮结束 | 后台进程：用户会话的 `agent_settled`，等这次的结束快照做完（§4.5）再读 | 立即 |
| 窗口回到前台 | 界面：`window` 的 `focus` 事件；对显示着的会话（分屏时两个）各发一次 | 立即 |
| 打开右栏、点 Refresh | 界面 | 立即 |
| Rewind、Undo 做完 | 后台进程（§5.7） | 立即 |
| Initialize git、建 worktree | §11 | — |

- **同一时刻只读一个**（按工作路径）：正在读时又来一次，记下“还要再读”，读完后再读一次（多次请求合成一次）；`workspace.status` 命令等到这“再读一次”完成才返回，
  所以命令的结果总是它发出之后的状态。
- **结果发给谁**：每读完一次，给这个工作路径上**所有打开的用户会话**各发一个 `mori.workspace_status`（在各自的信封上）；命令的结果与事件相同。
  后台进程触发的读也一样，所以分屏里两个同文件夹的会话一起更新。
- **快照状态变了**（§4.4 的 `state`、`error`、`skipped`、`nested` 变化）时，后台进程用最近一次读到的 git 状态加新的 `snapshots` 再发一次 `mori.workspace_status`，不重新读 git。
- 不监视、不轮询：没有 `fs.watch`、`watchFile`、`setInterval`；你在终端里提交、切分支，等下一个时机（回到 Mori 窗口、点 Refresh）才显示。

## 4. 内部仓库与快照：存放、调用 git 的方式、时间线、排除与上限、一轮的改动、保留与整理

本节是 proposal §3“内部仓库放在工作路径外”、§4“快照”“一轮的改动”、§5.1、§8“快照”“一轮的改动”、§9 第 4、5 条、§13 第 14–17 条的实现。

### 4.1 存放与归属

- **快照目录**：主进程启动后台进程时，在 `start` 消息里加 `snapshotsDir`（`app/src/main/kernel-process.ts:54`，后台进程 `app/src/kernel/index.ts:91`）：
  环境变量 `MORI_SNAPSHOTS_DIR` 有值时用它（测试用，照 `MORI_USER_DATA` 的写法，`app/src/main/index.ts:15`），否则 `%LOCALAPPDATA%\Mori\snapshots`。
  不放进 `%APPDATA%\Mori`（漫游配置），也不在 OneDrive 里（proposal §13 第 15 条）。
- **每个工作路径一个内部仓库**：`<snapshotsDir>\<编码>\`，编码用 `projectDirName(cwd)`（`app/src/kernel/memoryFiles.ts:24-26`，与 pi 会话目录同一种编码，
  `app/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:290-295`）：大小写不同、子文件夹都算不同的工作路径（同记忆规格 §3）。时间线、排队也按这个编码分（§4.5）。
- **归属**：内部仓库里写 `mori.json`：`{ "cwd": "<解析后的工作路径>" }`。打开时 `cwd` 不同（两个路径编码相同，例如 `C:\a-b` 与 `C:\a\b`）→ 这个工作路径的快照为 `off`，
  原因 `Snapshots are off for this folder: its snapshot folder belongs to <cwd>.`。
- **隔离的全局配置**：`<snapshotsDir>\gitconfig`，内容只有
  ```
  [safe]
  	directory = *
  ```
  内部仓库的调用用它代替你的全局配置（`GIT_CONFIG_GLOBAL`），并且不读系统配置（`GIT_CONFIG_NOSYSTEM=1`）。这样你的 `commit.gpgSign`、`core.autocrlf`、
  Git for Windows 系统配置里的 LFS 过滤器（`filter.lfs.required=true`，u-a8）都不作用于快照。`safe.directory` 只在受保护的配置里有效：
  本机 2.55 的文档说是 system、global、command 三种范围（`git-config` 的 SCOPES），较早的版本（2.35.2 起有这一项）只认 system、global，
  所以写在这个全局文件里，各版本都认。这样不是 git 仓库的工作路径属于别的 Windows 账户时快照照样能拍；是 git 仓库、而你的 git 因为
  `detected dubious ownership` 拒绝它时，`repoInfo` 是错误（§3.4 第 2 步），排除规则问不了你的 git（§4.3），这一张快照失败，`error` 为那句原文（§4.4 第 1 步）。
  每次内部仓库调用（`isolated: true`）之前检查 `<快照目录>\gitconfig`，不存在就写出（`writeFile` 带 `wx`，不覆盖；没有 `<快照目录>` 就建）：
  文件不存在时 git 静默忽略 `GIT_CONFIG_GLOBAL` 指向的文件，`safe.directory = *` 就等于没写。`GIT_CONFIG_GLOBAL` 从 2.32 起才有，所以最低版本是 2.32（§3.2）。
- **建立**（这个工作路径第一次拍快照时）：`git init --quiet`（§3.3 内部仓库的方式；git 会在内部仓库的 config 里写 `core.worktree`，但每次调用都显式传 `--work-tree`，不靠它），
  写 `mori.json`，再写 `info/attributes`（内部仓库里还没有 `HEAD` 时先删掉半建的目录再建，`git init` 不受停止影响，写完这两个文件才响应停止；每个内部仓库在这次后台进程里的第一个作业核对 `info/attributes`，缺了或不同就记日志并重写（2026-10-27 注：负责人不在时按推荐定，待复核））：
  ```
  * -text !eol -filter -ident -working-tree-encoding
  ```
  `info/attributes` 优先于工作路径里的 `.gitattributes`：快照按字节原样存、原样恢复，不做换行转换、不跑过滤器（LFS 文件存成指针原文）、不转编码。
  否则 `* text=auto eol=lf` 一类设置会让 Rewind 把 CRLF 文件写成 LF（本规格起草时复测：没有这个文件时快照里的 CRLF 变成 LF；有它时存进去、恢复出来都是 CRLF）。
  `diff` 属性不动，二进制照常认出来。
- **陈旧的锁**：同一个后台进程里 Mori 是内部仓库唯一的写入者（两个实例同时运行的情况见 §0“已知的限制”），作业又按工作路径排队（§4.5），所以每个内部仓库在这次后台进程里的第一个作业开始前，删掉 `index.lock`、
  `packed-refs.lock` 和 `refs/` 下的 `*.lock`（上次被强行结束时留下的），记一行日志。内部仓库的 git 进程被 Mori 结束（超时、§4.5 的停止）之后，
  同样先删掉这些锁再做下一个作业：被结束的 `git add` 会留下 `index.lock`，不删的话之后每张快照都失败。
- 这个目录里只有 git 自己的文件和上面三个文件；会话文件里的记录（§4.6）不放这里。

### 4.2 调用方式

- 内部仓库的每次调用都是 §3.3 的“内部仓库的方式”：`--git-dir=<内部仓库> --work-tree=<工作路径>` 加固定的 `-c`，隔离的配置，进程的 `cwd` 是工作路径。只动 ref 与对象的 `for-each-ref`、`update-ref`、`prune` 以内部仓库的目录为 `cwd` 与 `--work-tree`：删除会话时工作路径可能已经不在（worktree 先被删掉、文件夹被你删了），§4.7 照样能整理（2026-10-27 注：负责人不在时按推荐定，待复核）。
- **工作树就是工作路径**，不是仓库根：工作路径是仓库子文件夹时，快照只含这个子文件夹（会话的边界，proposal §4）。所有记下的路径都相对工作路径、用 `/`，
  与 pi 工具的相对路径、右栏 This session 的显示一致；仓库根以后变了（你在上一级 `git init`）也不影响已有的快照。
- 工作路径里的 `.git`（目录或 worktree 的 `.git` 文件）git 自己不收；嵌套的仓库（子模块、Claude 的 `.claude/worktrees/*` 这类）只记成 gitlink（mode 160000），
  里面的文件不进快照（u-a8 实测 Mori 仓库的 8 个 gitlink）。git 认出的符号链接记成 mode 120000。这两种 §4.6 都不列、§5.7 都不恢复。
  嵌套仓库不跟踪，This session 上方一行说明列出它们的路径（写规格时定的第 8 条，§4.4 第 7 步、§5.3）。
- **目录 junction 不是链接**：Git for Windows 把 junction 当普通目录，里面的文件照常进快照（本规格复核时在 2.55 上实测：内部仓库与你的仓库都记成
  `junc/t.txt`，mode 100644；`git init` 写的 `core.symlinks=false` 或 `-c core.symlinks=true` 都一样）。所以 junction 指向的文件也在 This session 里，
  Rewind 经 junction 恢复它们。这与 §6 路径闸按字面判断“工作路径里”一致，不另做处理（临时默认值，§17）。
- 给 restore、diff、ls-tree 的路径用 `--literal-pathspecs`（路径里的 `*`、`?`、`[` 不当通配符）；`add` 要用 `:(exclude)`，改为每条写成 `:(literal,exclude)<路径>`。
- 提交身份：`-c user.name=Mori -c user.email=mori@localhost`，消息 `Mori snapshot`，没有父提交（`commit-tree <tree>`）。

### 4.3 排除：和 git status 一样

内部仓库自己会读工作路径里各级的 `.gitignore`（它们在工作树里）。另外的规则写进内部仓库的 `info/exclude`，每次拍快照前按下表重新生成，内容变了才写：

| 部分 | 内容 |
| --- | --- |
| 总是 | `/.work/`、`/.mori/worktrees/`（只在工作路径根；proposal §4。`.work/.gitignore` 的 `*` 本来就排除它，这里是再保一道） |
| 是 git 仓库 | 问你的 git：在工作路径里跑 `git ls-files -z --others --ignored --exclude-standard --directory`（用户仓库的方式，键是仓库根），每条写成一行以 `/` 开头的锚定规则（目录保留结尾的 `/`）。路径里的 `\`、`*`、`?`、`[`、行首以外的 `!`/`#` 不会出现在行首，前面加 `\` 转义；结尾的空格写成 `\ ` |
| 不是 git 仓库 | `node_modules/`、`.venv/`、`dist/`、`build/`、`target/`（proposal §13 第 14 条；不带前导 `/`，任何一层都排除） |

- **为什么问 git，不复制文件**：工作路径是仓库子文件夹时，仓库根和中间各级的 `.gitignore`、`.git/info/exclude`、全局的 `core.excludesFile` 里的锚定规则都是相对仓库根的，
  搬到以工作路径为根的内部仓库里要改写，改写不全就和 git status 不一样。`ls-files --others --ignored --exclude-standard` 用的正是 git status 的全部规则（各级 `.gitignore`、
  `info/exclude`、`core.excludesFile`，任何一级配置），`--directory` 把整个被忽略的目录收成一行（本机 Mori 仓库根 9 行，`app/` 里 7 行，0.13 秒）。
- 路径相对进程的 `cwd`（工作路径），只列工作路径里的。一个目录里眼下的文件全被忽略时，git 把这个目录也列成一行（`src/`，同时列出 `src/a.log`；
  本规格复核时实测）；规则每张快照前重新生成，那个目录里后来有了不被忽略的文件，下一张就不再排除它，与那一刻的 git status 一致。
  整个工作路径都被忽略时（例如打开的是仓库里被忽略的 `build/`）输出 `./`：写成 `/*`，快照是空的，This session 没有记录，与 git status 一致。
- 被你 `git add -f` 跟踪、又匹配忽略规则的文件，`--others` 不会列出，所以照样进快照，和 git status 照样显示它的改动一致。（2026-10-27 注：负责人不在时按推荐定，待复核：实测内部仓库的 `add -A` 自己读工作树里的 `.gitignore`，不加这些文件；所以有仓库时每张快照前另问你的 git `ls-files -z --cached --ignored --exclude-standard`，把还在磁盘上的（`/.work/`、`/.mori/worktrees/` 除外）用 `add -f` 分批加进内部仓库，再 `add -A` 收尾）
- 文件一旦进了内部仓库的 index，之后你再加忽略规则，内部仓库仍跟踪它（git 对已跟踪的文件不看忽略规则）。不另做清理（§17）。

### 4.4 拍一张快照

一个“快照作业”在这个工作路径的队列里依次做（§4.5），任何一步失败都停下。下面的上限（单个文件 10 MB、20000 个新文件、分批的 2000 条、每个 git 进程 120 秒）
是 `snapshots.ts` 的参数（测试用，单元测试传很小的值，§19.1），默认见 §17：

1. 第一次时建立（§4.1）：“第一次”= 内部仓库目录里没有 `HEAD` 文件；这时 `git init`、写 `mori.json` 与 `info/attributes`，并把这个工作路径的 `last` 置为 null。
   生成 `info/exclude`（§4.3）。是不是仓库按这一刻的 `repoInfo`；`repoInfo` 是错误（§3.4 第 2 步）时这一张失败，`error` 为它的原文。
2. **列出新文件**：内部仓库 `git ls-files -z --others --exclude-standard`，得到这次 `add` 会新加的文件 N。
3. **文件数**：N 多于 20000 个，或第 2 步的输出被 16 MB 的上限截断（`truncated`，那已远多于 20000 个）→ 这个工作路径**暂停快照**（`paused`），不拍这一张，
   也不做下面的 `stat`，原因 `Snapshots are paused for this folder: more than 20,000 new files would be added. Add generated folders to .gitignore to resume.`。
4. **大文件**：对 N 里的每个文件异步 `stat`（`fs.promises`，不阻塞后台进程），大于 10 MB 的是候选；是 git 仓库时，把候选作参数交给你的 git `--literal-pathspecs ls-files -z --`
   （`ls-files` 不认 `--pathspec-from-file`，按 §3.3 分批）看哪些已被你跟踪，
   **已跟踪的不跳过**；其余的跳过（proposal §13 第 14 条“单个未跟踪文件超过 10 MB 不进快照”）。跳过的写进 `skipped`（界面列出前 20 个）。
5. **加入**：N 去掉跳过的多于 2000 个时先分批加：每批不超过 2000 条路径，经 `git --literal-pathspecs add --pathspec-from-file=- --pathspec-file-nul` 交给一个 git 进程
   （每个进程 120 秒），每批都写进内部仓库的 index；某一批超时 → 这一张到此为止，按下面的“超时”处理，已进 index 的批次留着，下一个快照点第 2 步的
   `ls-files --others` 只列剩下的。都成功后（或 N 不多于 2000 个时直接）`git add -A --pathspec-from-file=- --pathspec-file-nul`，stdin 为 `.` 加每个跳过文件的
   `:(literal,exclude)<路径>`（没有跳过的文件时直接 `add -A -- .`），收尾处理改动与删除。
6. `git write-tree` → 树 T。T 等于上一张快照的树 → 这一张就是上一张（不建新提交，`oid` 相同）。
7. 否则 `git commit-tree T -m "Mori snapshot"` → 提交 S（没有父提交）；再 `git ls-tree -r -z T` 找出 mode 160000 的条目（工作路径里嵌套的 git 仓库，§4.2），
   写进 `nested`（树没变时沿用上一张的）。
8. 段的处理与记录（§4.5、§4.6）；`git update-ref --stdin` 一次写完这一张用到的全部 ref（§4.7）。

```ts
/** @brief 一个工作路径的快照状态（WorkspaceStatus.snapshots）。 */
interface SnapshotState {
  /** on：照常；paused：暂停（reason 写原因）；off：不可用（git 不是 ok、归属冲突） */
  state: 'on' | 'paused' | 'off';
  /** paused、off 的原因原文；on 时为 null */
  reason: string | null;
  /** 最近一次快照失败的原文（Couldn’t take a snapshot 后面那部分）；成功一次就清掉 */
  error: string | null;
  /** 最近一次快照跳过的大文件（相对工作路径），最多 20 个 */
  skipped: string[];
  /** 跳过的大文件总数 */
  skippedTotal: number;
  /** 最近一张快照里嵌套的 git 仓库（gitlink，相对工作路径），最多 20 个 */
  nested: string[];
  /** 嵌套仓库的总数 */
  nestedTotal: number;
}
```

- **暂停之后**：因文件数暂停时，每个快照点（运行开始、结束）仍做第 1–3 步重新数（暂停时 Rewind 不恢复代码，§5.6 第 1 步，所以不在这里数）；降到 20000 以内就恢复（`on`），这一张作为新的基准（§4.5 的“上一张”清空，暂停期间的改动不记）。
- **超时**：某个 git 进程超过 120 秒 → 结束它（§4.1 随后删掉它留下的锁），这一张 `error`，原文 `a snapshot step took longer than 2 minutes`，不暂停，
  “上一张”清空（同下面的其他失败），下一个快照点续做（第 5 步已进 index 的批次不用重加）；同一工作路径**连续 3 张**都超时才 `paused`，原因
  `Snapshots are paused for this folder: a snapshot took longer than 2 minutes. They resume when Mori restarts.`，到后台进程重启前不再试（每次运行开始都白等 120 秒太久）。
  中间有一张成功（或因别的原因失败）就重新数。
- **其他失败**（git 报错、磁盘满）：这一张没拍成，`error` 为原文，记错误日志；“上一张”清空，下一个快照点照常再试。
  工作路径里有还没有提交的嵌套 git 仓库（例如 Agent 在子目录里刚 `git init`）时第 5 步的 `add` 就这样失败（本机 2.55 实测：
  `error: 'sub/' does not have a commit checked out`、`fatal: adding files failed`），`error` 为 `'sub/' does not have a commit checked out`；
  它有了提交或被加进 `.gitignore` 之后下一张恢复（§0 已知的限制，FS-26）。
- **实测**（u-a8；本规格起草时在本机复测，内部仓库放在 scratchpad，第 1、2、5–7 步）：

  | 文件夹 | 情况 | 耗时 |
  | --- | --- | --- |
  | Mori 仓库（844 个文件进快照） | 第一张 | 2.8 秒（u-a8）/ 4.4 秒（复测，含忽略列表与新文件列表） |
  | Mori 仓库 | 之后每张（没有改动） | 0.57–0.9 秒（u-a8）/ 0.72 秒（复测） |
  | Mori 仓库 | 内部仓库大小（散对象） | 15 MB |
  | `app/node_modules`（30,385 个文件，不排除） | 第一次 `add -A` / 带自动 gc 的提交 | 76 秒 / 54 秒（自动 gc 已关，§3.3；这种文件夹会在第 3 步暂停） |
  | `app/node_modules` | 之后每次 `add` 加 `write-tree` | 0.26–1.59 秒 |

  公司仓库上的耗时、协作模式下快照的次数要在真实层量一次（FS-21，proposal §14）。

### 4.5 时间线

**谁拍**：同一个工作路径上，每个打开的用户会话和它的后台实例，每次运行开始、结束各拍一张（proposal §4“快照”）。不拍的：增强任务的看不见的会话和它的实例
（记忆规格 §9.6；它们没有右栏，也不能 Rewind，改动按“别人改的”算，§17）；没装 git、`off`、`paused` 时不拍。

**接在 pi 的哪里**：新的 inline extension `mori-snapshots`（`kernel/snapshots.ts` 导出工厂），用户会话与实例会话都注册，放在 `mori-approval` 之后、`mcp` 之前
（`app/src/kernel/sessions.ts:316-317`）；和 `mori-approval` 一样是必需的扩展，加载失败时会话不打开（`app/src/kernel/sessions.ts:342-364`）。
看不见的增强会话和它的实例也注册它，但只做 `tool_execution_end` 的刷新，不拍快照。它处理：

| pi 事件 | 做什么 | 等不等 |
| --- | --- | --- |
| `before_agent_start` | 记下这一刻用户会话的叶子（`sessionManager.getLeafId()`；不一定等于 `entry.runStart`（`app/src/kernel/sessions.ts:990`）：准备中模型层的重建、pi 在处理器之前做的压缩（`app/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1452-1455`）都可能写下条目）和事件的 `messageType`（`'user'`：由一条 user 消息开始；`'custom'`：由扩展的 `sendMessage(…, { triggerTurn })` 开始，没有起始消息，`app/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:727-742`），排一个“运行开始”的快照作业，**等它做完**再返回；这个工作路径是 `off`、`paused`（因文件数暂停的，这次重新数仍超过上限；因连续超时暂停的，到重启为止，§4.4）时不拍，只登记这次运行。用户会话自己的运行在排作业之前在它的信封上发 `mori.snapshot_stage { active: true }`，作业做完、失败、被停止或不拍（`off`、`paused`）时发 `{ active: false }`，界面的阶段行这期间显示 `Taking a snapshot… · <秒数>`（§13、fs-changes.md；排在别的作业后面等的时间也算在内）；实例的运行不发（同实例的批准卡不改对话的阶段行） | 等。pi 依次 await 每个处理器（`app/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:1130-1142`），工具在这之后才执行，所以快照一定在这次运行的任何改动之前 |
| `agent_settled` | 排一个“运行结束”的快照作业 | 不等：处理器同步返回，不推迟 pi 发给界面的 `agent_settled`（`app/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:684-702`）。同一工作路径的下一次运行开始要排在它后面，顺序不会乱 |
| `tool_execution_end` | §3.5 的去抖刷新 | — |

- **pi 发了 `before_agent_start` 却没有开始运行**：`_prepareRun` 在处理器之后出错时 pi 不发 `agent_settled`（`app/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1392-1405`）。这时没有工具执行过：
  这次 `prompt()` 结束时（用户会话在 `settleRun`，`app/src/kernel/sessions.ts:872-877`；实例在 Team 等它 prompt 结束的地方）把这次运行从“在运行”里去掉，不拍结束快照。
- **停止**：运行开始的快照还没做完时这次运行被停止（你按停止，`stopRun`，`app/src/kernel/sessions.ts:1109-1123`；Team 停止实例时同样经它的中止入口通知快照模块），快照模块结束这个作业的 git 进程，这次运行没有开始快照（也就没有 code restore），
  也不登记进 `active`、不拍结束快照：pi 在 `agent_start` 处就中止，第一次请求都不发（`app/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:711-714`），没有工具执行。别人的作业不受影响。
  通知的位置与顺序：`stopRun` 在 `rejectForStop` 之后、`session.abort()` 之前；`release`（关闭会话、`shutdownSessions`、Team 的 `closeInstance`、建会话失败的收拾都经过它，
  `app/src/kernel/sessions.ts:782-794`）在 `await session.abort()` 之前先通知快照模块结束这个会话正在等的开始快照作业。必须由 Mori 通知：pi 的 `abort()` 要等
  `waitForIdle()`（`agent-session.js:1942-1954`），运行停在 `before_agent_start` 时 `_isAgentRunActive` 已经为真（`:1392-1398`），而 `ctx.signal` 在这里是
  `agent.signal`（`:2789`），运行还没开始时为 undefined，快照模块靠它学不到中止；不通知的话 `abort()` 要等 `git add` 跑完，退出时超过主进程的 3 秒上限。
- **有序退出**：`shutdownSessions`（`app/src/kernel/sessions.ts:1612-1622`）之后等所有工作路径的队列做完（被中止的运行的结束快照），仍受主进程 3 秒的上限
  （`app/src/main/kernel-process.ts:12`）；没做完的记录就没有（崩溃时同样），不报错。

**排队**：每个工作路径一个作业队列，快照作业、Rewind、Undo、`snapshots.diff`、`snapshots.drop` 都排在里面，一个做完再做下一个（“同一个工作路径同一时刻只拍一张”）。
不同工作路径（例如各自的 worktree）并行。

**时间线的状态**（只在内存里，`kernel/snapshots.ts`）：

```ts
/** @brief 一个工作路径的时间线。 */
interface Timeline {
  /** 上一张快照的提交与树；还没有、失败或暂停后为 null */
  last: { oid: string; tree: string } | null;
  /** 正在运行的：每次运行一项，在它的开始快照之后、结束快照之前 */
  active: Map<string, ActiveRun>;
  /** 每个有运行在进行的用户会话：这一段开始时的情况（段的归属用） */
  open: Map<string, { leaf: string | null; own: boolean }>;
}
/** @brief 一次运行。 */
interface ActiveRun {
  /** 所属的用户会话（实例为它的 owner） */
  user: string;
  /** 标出的 Agent：用户会话自己的运行 self 为真、role 为这时持有对话的角色（基座 mori）；实例为它的角色与 task */
  agent: { role: string; task: string | null; self: boolean };
  /** 用户会话自己的运行：开始快照、开始时的叶子、是否由 user 消息开始（before_agent_start 的 messageType）；实例为 null */
  own: { start: string | null; leaf: string | null; byUser: boolean } | null;
}
```

**一张快照做完后**（第 8 步）：

1. **段**：上一张 `last` 到这一张之间叫一段。`last` 为 null（第一张、失败或暂停之后）、树没变、`active` 为空（没人在运行）→ 这一段不记给任何人。
2. 否则一次 `git diff --no-renames --raw --numstat -z <last> <这一张>`（本规格起草时核对过这两个格式可以一起输出，复核时再测：先是全部 raw 记录，再是全部 numstat 记录），
   得到改动的文件（mode 160000、120000 的去掉）。这一段是 Rewind / Undo 的恢复（保险快照到恢复后快照，§5.7）时，再去掉这次恢复动过的文件（恢复集合 R）：
   它们是恢复，不是谁的改动；其余的文件是同一工作路径上别的会话这时还在跑时改的，照常记给它们。
3. **记给谁**：`active` 里涉及的每个用户会话各记一条（同一个会话不论有几个运行都只记一次），记进它这一段的“轮”（下面）；`agents` 是这个会话在 `active` 里的那些运行的 `agent`；
   涉及的用户会话多于一个，**或**这一刻别的工作路径上有运行在 `active` 里、而那个工作路径包含这个工作路径或在它里面（用 `insideDir` 比两边的 cwd，不读文件；
   两个方向都算，例如 `<R>` 与 `<R>\app`）→ `overlap: true`。这个会话自己的后台实例不算别的会话（proposal §5.3）。嵌套的工作路径各有自己的时间线，
   在 `<R>\app` 里开的会话写的文件也进 `<R>` 的快照，不标的话在 `<R>` 的会话里 Rewind 时会被不问就覆盖（§17）。
4. **更新**：这一张是谁的开始就把它加进 `active`，是谁的结束就去掉；然后给每个还在 `active` 里的用户会话记下新一段的开始
   `open[user] = { leaf: 它这时的叶子, own: 这一张是它自己由 user 消息开始的运行（own.byUser）的开始 }`。
   例外：这个会话自己由 user 消息开始的运行在进行、而它的起始消息还没写下（当前分支上 `own.leaf` 之后还没有 role 为 user 的消息条目，例如运行刚开始时一个实例恰好结束），
   记 `{ leaf: own.leaf, own: true }`，这一段仍归起始消息。不按“叶子没变”判断：第 3 步刚写下的记录、Team 的条目都会移动叶子。
5. `last` = 这一张。

**一段的“轮”**（proposal §4：记进当时那一轮，你最近的一条消息）：

- 你的消息 = 用户会话里 `role: 'user'` 的消息条目，且没有 `mori.wake` 指向它（程序投递的 `[Mori]` 消息不是你的话，`app/src/shared/team.ts:383-389`）。
- 段开始那张是这个会话**自己由 user 消息开始的运行的开始**（`open.own`）：轮是这次运行的**起始消息**——当前分支上 `open.leaf` 之后的第一条 role 为 user 的消息条目，且它是你的消息。
  由扩展的 custom 消息开始的运行（`messageType: 'custom'`）没有起始消息，`own` 为假：否则运行中插话的那条会被当成起始消息，拿到整次运行的改动和 code restore。
- 其他情况，或起始消息不存在（运行没写下消息就停了）、是程序投递：轮是从 `open.leaf` 往回找到的第一条你的消息。找不到（会话里还没有你的消息）→ 这一段先留着（只在内存里，`Timeline.held`），
  记进 `open.leaf` 之后写下的第一条你的消息：之后每张快照做完时再找一次，找到就写下记录（排在那一张自己那一段的记录之前）；`open.leaf` 已不在当前分支上（恢复了对话）时丢掉
  （2026-10-27 注：负责人不在时按推荐定，待复核：协作模式分开时立项在对话写下你的消息之前就判断、派出 task（§5.5“协作模式的限制”），task 的第一段改动落在会话里还没有你的消息的时候；
  按原文不记就违反 FS-11、FS-14，见 docs/v1/fs-checks.md 第 22 条）。
- 在写记录时（段结束时）才解析。这时 pi 已经写下了消息、Team 也写完了 `mori.wake`：pi 在 `before_agent_start`（`app/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1457`）之后才建这条用户消息（`:1469-1478`），
  在 `message_end` 时写进会话（`:765-772`）；Mori 补条目 id 在随后的微任务里（方案第 6 节第 4 件，`app/src/kernel/entries.ts:95-115`）；
  `mori.wake` 也在 `message_end` 之后的微任务里写（`app/src/kernel/team.ts:1261-1265`、`:1274-1279`）。快照作业结束在 git 进程退出之后，比这些微任务都晚。
- 所以运行中排队（Queue）、插话（Steer）的消息，只在它们写下之后才开始的段里成为“轮”；同一次运行里先前的改动仍归起始消息。一次运行里只有开始、结束两张快照时，
  整次运行的改动都归起始消息（proposal §4“它们和前一条消息在同一次运行里，没有自己的快照”）。

**运行记录**：用户会话自己的一次运行结束（结束快照做完，成没成功都算）时，起始消息是你的消息并且开始快照拍成了，就写一条 `run` 记录（§4.6）：
它把开始快照绑到这条消息上，是这条消息能 Restore code 的依据（§5.5）。程序投递、扩展发起（`messageType: 'custom'`）、没有开始快照的运行不写。后台进程在运行中途崩溃时这条记录没有，这条消息就没有 code restore。
开始快照拍成后、`run` 记录写下前，它由 `refs/mori/s/<会话 id>/run/<提交>` 保住（§4.7），写 `run` 记录时换成轮下的 ref：否则这期间只改了 gitlink 的一段不写记录，
开始快照没有 ref，别的会话删除时的 `prune` 会删掉它。

**例子**（同一工作路径，用户会话 A 带一个 task 实例 T（角色 Executor，做 T2），另一个用户会话 B）：

| 快照 | 事件 | 之前那一段记给 |
| --- | --- | --- |
| S1 | A 开始（你的消息 M3） | 没人在运行，不记 |
| S2 | T 开始 | A，轮 M3，agents [Mori]，overlap 否 |
| S3 | B 开始 | A，轮 M3（段开始时 A 最近的你的消息仍是 M3），agents [Mori, Executor (T2)] |
| S4 | A 结束 | A（轮 M3）与 B（轮 = B 的起始消息）各一条，overlap 是 |
| S5 | T 结束 | A（轮 M3，agents [Executor (T2)]）与 B 各一条，overlap 是 |
| S6 | B 结束 | B，overlap 否 |

### 4.6 一轮的改动：`mori.turn_changes`

用户会话的会话文件里写自定义条目 `mori.turn_changes`（`appendCustomEntry`，不进模型上下文），同时在用户会话的信封上发同名事件，内容相同。两种：

```ts
/** @brief 运行记录：这条你的消息开始的那次运行的开始、结束快照（§4.5）。 */
interface RunRecord {
  v: 1;
  kind: 'run';
  /** 起始消息的条目 id（这一轮） */
  round: string;
  /** 开始快照的提交 */
  start: string;
  /** 结束快照的提交；没拍成为 null */
  end: string | null;
  /** 写下的时刻（ms） */
  at: number;
}
/** @brief 一段的改动（§4.5）。 */
interface ChangesRecord {
  v: 1;
  kind: 'changes';
  /** 记进的轮：你的一条消息的条目 id */
  round: string;
  /** 这一段两端的快照 */
  base: string;
  head: string;
  /** 改动的文件，最多 500 个，按路径排序 */
  files: { path: string; status: 'A' | 'M' | 'D'; added: number | null; removed: number | null }[];
  /** 这一段改动的文件总数（多于 files 时界面说明没列全；Rewind 用 git 重新算全，§5.6） */
  total: number;
  /** 这一段在跑的这个会话的 Agent */
  agents: { role: string; task: string | null; self: boolean }[];
  /** 同一工作路径上别的用户会话这段时间也在运行 */
  overlap: boolean;
  at: number;
}
```

- `path` 相对工作路径、用 `/`；`status` 取自 `--raw` 的 A、M、D（`T` 记为 M）；`added`、`removed` 取自 `--numstat`，二进制（`-	-`）为 null。
- **写入时机**：作业做完时直接 `appendCustomEntry`，不等用户会话的助手消息写完。这些条目在界面上按 `round` 归组、不按位置显示（§5.3），写在哪一处都一样；
  作业在 git 进程退出后的回调里写，不会插进 pi 写消息的同步代码与它之后的微任务之间（`app/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:765-772`、`app/src/kernel/entries.ts:100`、`app/src/kernel/team.ts:1276`），
  所以不影响补条目 id 和 `mori.wake`。实例会话的段也写进用户会话的文件（proposal §8）。
- 重新打开会话时，界面从 `session.open` 的当前分支条目里读出它们（同 `mori.receipt`，`app/src/renderer/src/state/history.ts`），与实时收到的事件相同。
- **写到哪个会话文件**：快照模块登记一次运行时记下用户会话的 `SessionManager` 对象本身（用户会话自己的运行取 `before_agent_start` 的 `ctx.sessionManager`；
  实例的运行记它 owner 的，即用户会话在快照模块里登记时给出的那一个），记录经它 `appendCustomEntry` 写入。不经过 ctx：会话 `dispose()` 之后扩展的 ctx 失效
  （`agent-session.js:1007`），而 `SessionManager` 用 `appendFileSync` 写（`session-manager.js:812`），`dispose()` 不碰它。所以会话已从表里释放（有序退出时
  `shutdownSessions` 先 `sessions.clear()` 再 `release`，§4.5）之后做完的结束快照仍写进文件、不发事件；增强会话不写。没有文件改动的段不写。

### 4.7 保留与整理

- **ref**：`refs/mori/s/<会话 id>/<轮的条目 id>/<提交>`，指向这一轮的记录用到的每个提交（`run` 的 `start`、`end`，`changes` 的 `base`、`head`）；
  Rewind 与 Undo 用到的提交在 `refs/mori/s/<会话 id>/rewind/<mori.rewind 条目 id>/<提交>`；进行中的运行的开始快照在 `refs/mori/s/<会话 id>/run/<提交>`
  （§4.5“运行记录”；运行结束时删掉，崩溃时留到删除会话）；`refs/mori/last` 指向时间线的上一张（防止整理时被删）。
  同一个提交可以被几个会话、几轮各自引用。全部在内部仓库里，你的仓库里没有新的 ref（proposal §3）。
- **每个会话保留最近 100 轮**（proposal §13 第 16 条，照 Claude；轮数是 `snapshots.ts` 的参数，测试用，默认见 §17）：每写一条 `run` 记录时，按会话文件里 `mori.turn_changes` 出现的先后列出不同的 `round`（所有分支），
  多于 100 个时删掉最早那些轮的 ref（`for-each-ref` 列出、`update-ref --stdin` 删）。会话文件里的记录不删：This session 照常列出这些轮，点开 diff、Rewind 到它们时报
  `Mori keeps snapshots for the last 100 turns of a session. This turn’s snapshots were removed.`。`rewind/`、`run/` 下的 ref 不算轮，留到删除会话。
- **删除会话**：界面在 `mori:delete-session` 成功后（`app/src/main/index.ts:118`）发 `snapshots.drop { sessionId, cwd }`；排进那个工作路径的队列：
  删掉 `refs/mori/s/<会话 id>/` 下的全部 ref；`refs/mori/s/` 下已经没有 ref、也没有打开的用户会话在用这个工作路径时，删掉整个内部仓库目录；
  否则 `git prune --expire=now`（只删不可达的散对象，比 `gc` 快，不重新打包）。没装 git 时只删不了 ref，不报错（目录留着）。
  删掉内部仓库目录后，这个工作路径在内存里的 `Timeline` 一并丢掉（`last` 为 null、`open`/`active` 为空：这时本来没有打开的用户会话），
  下一张快照从“第一次”开始（§4.4 第 1 步），不会拿已被删掉的 `last.oid` 当作“树没变”的上一张。
- 没有后台整理、没有定时清理（proposal §9 第 5 条）；归档不动快照。

## 5. 右栏 This session 与 Rewind

本节是 proposal §4“Rewind”、§5.3、§6 的“顶栏”“右栏 Changes”“你的消息”、§9 第 4 条、§13 第 17–19 条的实现。屏幕状态表：
[fs-changes.md](../v1/screens/fs-changes.md)（顶栏、右栏）、[fs-rewind.md](../v1/screens/fs-rewind.md)（Rewind）。

### 5.1 右栏的结构

右栏的“改动”视图（`ChangesPanel.tsx` 重写）标题改为 `Changes`（照 Claude 的 Changes），标题栏有 `Refresh`（只读 git 状态）与 `Close panel`。下面按 `WorkspaceStatus` 分三种：

| 文件夹 | 上半部分 | 下半部分 |
| --- | --- | --- |
| git 仓库 | git 状态（§5.2） | This session（§5.3） |
| 不是 git 仓库 | `Not a git repository` 和 `Initialize git…`（§11，[fs-worktree.md](../v1/screens/fs-worktree.md)） | This session |
| 没装 git（`missing`） | 只有 `Git is required to track changes and rewind.`（proposal §13 第 19 条，不再列编辑和写入） | 无 |
| git 版本太低（`old`） | 只有 `Git 2.32 or newer is required to track changes and rewind (found <version>).` | 无 |
| 认不出仓库（`repo` 为 null、`error` 不为 null，§3.4 第 2 步） | `Couldn’t read git status: <原文>`（不写 `Not a git repository`，没有 `Initialize git…`） | This session |

- 原来的 `Only edits and writes are listed. Files changed by commands aren’t included.` 和 `Changes made by team tasks aren’t listed here.` 都去掉；
  `BoardView.teamEdited`（`app/src/shared/team.ts:233-234`）只给后者用，随之删掉（team.ts、teamView.ts 里算它的代码一并删，不留兼容）。
- 文件阅读器、`← Changes`、`Reload file`、`Open in default app` 不变（v0 changes.md）。阅读器自动重读的依据从“这个会话对它的编辑、写入次数”（`app/src/renderer/src/components/ChangesPanel.tsx:41-45`）
  改为“当前分支上列出这个文件的 `changes` 记录条数”：新的一段记到它就重读一次。
- 自动打开：这个会话第一次收到 `mori.turn_changes`（`changes`）时右栏自动打开到 Changes；你手动开关过之后以你为准（沿用 v0 的临时默认值，`docs/v0/defaults.md:43`）。
  现在按“对话流里有完成的 edit、write”判断（`app/src/renderer/src/App.tsx:238-241` 的 `hasChanges` 用 `collectChanges`），改为“当前分支上有 `changes` 记录”。
- 顶栏 `Toggle changes` 的读屏名不变，悬停文字由 `This session’s changes`（`app/src/renderer/src/components/ChatPane.tsx:209`）改为 `Changes`。

### 5.2 git 状态列表

- **分支行**：分支名；`head` 为 null 时 `HEAD detached at <oid 前 7 位>`；`oid` 为 null 时加 ` · No commits yet`；有上游时 ` · <upstream>`，再加领先、落后：
  `1 ahead`、`2 behind`、两者都有时 `1 ahead, 2 behind`、都为 0 时 `Up to date`；有上游、`ahead` 为 null 时 ` · <upstream> (gone)`。
- **分组**：依次 `Conflicts · <n>`、`Staged · <n>`、`Unstaged · <n>`、`Untracked · <n>`，没有的组不显示；每行是状态字母（悬停 `Modified`、`Added`、`Deleted`、`Renamed`、`Copied`、
  `Type changed`、`Conflicted`；未跟踪的不带字母）和相对仓库根的路径（重命名 `<from> → <path>`）。
- **点一行**：在文件阅读器里打开 `<toplevel>\<path>`（主进程的阅读器接受绝对路径，`app/src/main/files.ts:21-31`）。删掉的显示 `File not found`，未跟踪的目录显示 `Preview unavailable · This is a folder`（v0 的状态）。
  不在这里显示 git 的 diff（proposal 只给 This session 点开看 diff）。
- 没有未提交的文件：`No uncommitted changes`。超过 500 条：列表下 `Showing 500 of <total> files.`；输出被截断（`truncated`，总数不可知）时写
  `Showing the first 500 files.`。读失败：`Couldn’t read git status: <原文>`。
- 不是仓库、没装 git 时没有这一块（§5.1）。

### 5.3 This session

数据全部来自当前分支上的 `mori.turn_changes`（条目和实时事件），界面自己归组，不再向后台进程要列表。

- **按轮**：每个有 `changes` 记录的轮一组，新的轮在上（§17）。组标题 `Turn <n> · <你那条消息的第一行>`：`n` 是这条消息在当前分支上是第几条你的消息
  （不算 `[Mori]` 投递，即 `mori.wake` 指向的 user 消息），第一行太长时省略号截断，悬停看全文。
  `n` 与会话引用的 Turn N 共用一个计数：纯函数 `turnNumbers(entries)`（`state/model.ts`，跳过 `mori.wake` 指向的 user 消息）。会话引用的 `sessionTurns`
  （`app/src/renderer/src/state/sessionRefs.ts:78-91`，现在把投递也算一轮）改用它：`mori.wake` 指向的消息的 `User:` 几行接到前一轮里，不另起一轮，内容不丢（2026-10-27 注：负责人不在时按推荐定，待复核：实现时核对，`session.read` 本来就不交投递的消息与 `mori.wake` 条目（平行 Agent 规格 §13.11，`kernel/entries.ts` 的 `quotableEntries`），引用里没有它们的 `User:` 几行，编号也已跳过它们；照旧不交，模型看到的引用文字不变，见 docs/v1/fs-checks.md）
  （前面没有轮时同第一条你的消息之前的回复，不算在任何一轮里）。这样右栏、Rewind 通知与会话引用的预览、芯片（`Turn 3 · ~1,200 characters`、`turns 3–4`）里同一个编号指同一条消息。
- **组里的文件**：这一轮各条记录里的文件合并，按第一次出现的先后。每行：
  - 状态字母（悬停 `Added` / `Modified` / `Deleted`）：这一轮里第一次出现时是 A → 开始前没有；最后一次是 D → 现在没有；两者都没有 → M；开始前没有、现在也没有（建了又删）→ D；
  - 路径（相对工作路径）；
  - `+<added> −<removed>`：这一轮各段之和（二进制的段不计；都是二进制时写 `Binary`）；
  - Agent：这个文件出现过的各段的 `agents` 合起来，全是 `self`（只有对话本身）时不写；否则写名字，用 `, ` 隔开：`self` 写持有对话的角色名（基座 `Mori`），
    实例写 `<角色名> (<task>)`，没有 task 时只写角色名；
  - `Open`（删掉的文件没有）：在阅读器里打开现在的文件。
- **点文件行**：展开这一轮这个文件的 diff：`snapshots.diff { sessionId, round, path }`，用这一轮里第一次列出它的那条记录的 `base` 到最后一次的 `head`。
  后台进程在工作路径的队列里跑 `git diff --no-renames <base> <head> -- <path>`（10 秒，结果最多 1 MB），原文交给现有的 `Diff.tsx`（@pierre/diffs 的 `PatchDiff`；
  实现前用一段 git 的输出核对它认 `diff --git` 头，FS-12）。二进制：`Binary file · No preview`；没有差别（改了又改回）：`No net changes in this turn.`；
  超过 1 MB：只显示前 1 MB，下面 `The diff is too large to show in full.`；ref 已被整理：§4.7 的原文；其他失败：`Couldn’t load the diff: <原文>`。
- **组下的说明**：这一轮有 `overlap` 的记录 → `Another session in this folder was running at the same time, so some of these changes may be theirs.`；
  有 `total` 多于 `files` 的记录 → `Some files in this turn aren’t listed. Too many changed at once.`。
- **This session 顶部的说明**（按 `WorkspaceStatus.snapshots`）：`paused`、`off` → 原因原文；`error` → `Couldn’t take a snapshot: <原文>`；
  有跳过的大文件 → `<n> large files aren’t in snapshots (over 10 MB).`（1 个时 `1 large file isn’t in snapshots (over 10 MB).`），悬停列出前 20 个路径。
- **嵌套仓库**（写规格时定的第 8 条，验收 FS-26）：`nested` 不为空时，This session 上方一行 `Changes inside nested repositories aren’t tracked: <路径>, <路径>`，
  列出 `nested`（相对工作路径）；`nestedTotal` 多于 20 时接 ` and <n> more`。它们里面文件的改动不在 This session 里，Rewind 也不恢复（§4.2）。
- 没有记录：`No changes yet.`（沿用）。
- 只恢复代码（Restore code）之后，那些轮仍在当前分支上，照样列出（它们是这个会话做过的事）；恢复对话后，丢掉的轮不在当前分支上，不再列出（§5.8）。

### 5.4 顶栏 `+N −M`

- 位置：顶栏 `Toggle changes`（`app/src/renderer/src/components/ChatPane.tsx:208-209`）的左边，一个按钮，文字 `+N −M`（`−` 是 U+2212），加号部分用新增色、减号部分用删除色（照 Claude 的改动指示）。
- N、M = 当前分支上这个会话全部 `changes` 记录的 `added`、`removed` 之和（null 不计）。只恢复代码不会让它变小；恢复对话后随当前分支变（§17）。
- 两者都为 0、没装 git、git 太低时不显示；这一栏不宽于 600 px 时不显示（同平行 Agent 规格 §13.1 的窄栏）。
- 点它：打开右栏的 Changes 视图（已经打开在 Changes 上时不变；打开的是阅读器时切回 Changes）。读屏名 `Changes in this session: <N> lines added, <M> removed`（N 为 1 时 `1 line added`）。

### 5.5 Rewind：哪些消息、哪些选项

- **按钮**：你的每条消息（`Transcript.tsx` 的 `UserMessage`，`:72-84`；技能调用的气泡一样）在悬停、或消息里的元素有键盘焦点时显示 `Rewind`；按钮一直在 Tab 顺序里。
  程序投递的 `[Mori]` 消息不显示为你的消息（`history.ts` 的 wake 条目），没有 Rewind。还没拿到条目 id（`entryId` 为 null）的消息没有 Rewind。
- **没装 git、git 太低**：没有 Rewind（proposal §3“Rewind 也跟着不可用”）。
- **不能用**：这个会话有 Agent 在运行、排队或有待判断的消息（`TeamState.busy`，`app/src/kernel/team.ts:460-463`；没有 Team 时为对话在运行或准备中）、或正在 Rewind / Undo：
  按钮不可点，悬停 `Still running`（同会话菜单的原因）。后台进程同样拒绝（`This session is still running. Stop it first.`，`app/src/kernel/sessions.ts:168`）。
- **菜单**（照 Claude 的四项，不做 Summarize）。一条消息 M“有 code restore”= 当前分支上有 `round` 为 M 的 `run` 记录（它写在 M 那次运行结束时，和 M 在同一个分支上）；“之后有改动”= 当前分支上有 `round` 为 M 或 M 之后的你的消息的 `changes` 记录。

  | M 的情况 | 菜单 |
  | --- | --- |
  | 有 code restore，之后有改动 | `Restore code and conversation`、`Restore conversation`、`Restore code`、`Never mind` |
  | 有 code restore，之后没有改动 | `Restore conversation`、`Never mind` |
  | 没有 code restore（排队、插话的消息；那次快照暂停、失败、`off`；功能上线前的旧消息），之后有改动 | `Restore conversation`、一行不可选的 `No code restore`、`Never mind` |
  | 没有 code restore，之后没有改动 | `Restore conversation`、`Never mind` |

- **协作模式的限制**（proposal §13 第 18 条）：当前分支上 M 或 M 之后有 `mori.receipt { kind: 'registered', request: n }`（`app/src/shared/team.ts:357-368`），
  而需求 n 仍是 `open`（`BoardView.requests`）→ 两个恢复对话的选项不可选，下面写
  `Request <n> is still open. The conversation can’t go back to before it was registered.`（几个时 `Requests 1 and 3 are still open. The conversation can’t go back to before they were registered.`）。
  `Restore code` 不受影响。后台进程按同一规则拒绝。
  需求本身没有记下是哪条消息登记的（`BoardRequest` 只有 `createdAt` 和原话 `words`，`app/src/kernel/teamTypes.ts:118-145`；分开时立项在对话的 `prompt` 之前判断，
  `createdAt` 还早于这条消息的时间戳），所以按回执的位置判断：平行 Agent 规格 §13.2 定了 `registered` 回执写在登记它的那条你的消息之后（合并会话里在那次工具调用之后，
  停止、撤回时在离开时的对话流末尾，都在这条消息之后）。
- `Never mind`、Esc 关掉菜单，焦点回到 `Rewind`。

### 5.6 计划与冲突

`rewind { sessionId, entryId, code, conversation, conflictChoice? }` 带 `code: true` 时，在工作路径的队列里：

1. **检查**：git 是 `ok`；快照不是 `paused`/`off`（否则 `Snapshots are paused for this folder, so code can’t be restored.` / §4.1 的原因）；
   有 `round` 为 M 的 `run` 记录（否则 `This message has no code snapshot.`）；它的 ref 还在（否则 §4.7 的原文）。基准 B = 它的 `start`。
2. **保险快照** P：在这个作业里照 §4.4 拍一张（是时间线上普通的一张；它之前那一段照常记给当时在运行的别的会话）。没拍成 → 命令失败，原文
   `Couldn’t take a snapshot: <原文>`，什么都不改。
3. **文件集合** F：当前分支上 `round` 是 M 或 M 之后的你的消息的全部 `changes` 记录的文件之并；`total` 多于 `files` 的记录用 `git diff --name-only -z --no-renames <base> <head>` 补全。
   只含这个会话记下的文件（proposal §5.3“恢复只动这个会话记下的文件”）。
4. **冲突**（两种，proposal §5.3）：
   - `changed`：F 里在这个会话**最近一张快照** L 之后又变了的：`git diff --name-only -z --no-renames <L> <P>`（不带 pathspec，§3.3），与 F 取交集。L = 会话文件里按先后最后一个
     `run.end`、`changes.head`、`mori.rewind` 的 `post`（不为 null 的）。
   - `overlap`：F 里出现在 M 起 `overlap: true` 的记录里的。两种都是时记 `changed`。
5. 有冲突，而调用没带 `conflictChoice`，或带来的 `token` 与这一次算出的冲突集合的 `token` 不同（这期间冲突变了）→ 返回
   `{ kind: 'conflicts', conflicts, total, token }`，什么都不改（P 留在时间线上，不建 ref）。`token` = 按路径排序的全部冲突（路径与原因）的 SHA-1 前 16 位，
   所以冲突多于界面列出的 200 条时也能比较。界面列出来让你选 `Overwrite` / `Skip these files` / `Cancel`（[fs-rewind.md](../v1/screens/fs-rewind.md)）；Cancel 不再调用。
6. 没有冲突，或带着 `token` 相同的 `conflictChoice`：恢复集合 R = F（`overwrite`）或 F 去掉冲突（`skip`），做 §5.7。

### 5.7 恢复代码

1. `git ls-tree -r -z --name-only <B>`（在工作路径里跑，路径相对工作路径）读出 B 的全部文件，与 R 求交得到 R 里在 B 中存在的文件 E。
2. R − E（B 里没有、是后来新建的）：逐个 `fs.rm`（不递归；已经不在的跳过）。**先删再恢复**：Windows 不分大小写，R 里可能同时有 `README.md`（B 里有，记录里是 D）
   和 `Readme.md`（后来新建，A），先恢复再删会把刚恢复的文件删掉（复核时在 2.55 上实测；同一段里的改名内部仓库只记 `M`，所以只有跨快照的删、建才这样）。
   留下的空目录不删。**不用 `git clean`**：没有记下的文件（你自己新建的、跳过的大文件、嵌套仓库里的）一律不动。
3. E：`git --literal-pathspecs restore --source=<B> --worktree --pathspec-from-file=- --pathspec-file-nul`（只改工作区，不碰你的 index；本规格起草时复测：删掉的文件也恢复了）。
   整批失败（例如一个文件被别的程序锁着）时逐个再试，失败的记进 `failed`。
   恢复前逐个检查挡路的：上级目录现在是文件、符号链接或目录联接时不恢复，`failed` 原文 `A file is in the way.`；文件的位置现在是目录时，里面只有空目录就逐层 `rmdir` 掉再恢复，有别的东西（文件、链接、嵌套仓库的 `.git`）就不动，原文 `A folder is in the way.`（`git restore` 会删掉挡路的整个目录与文件，里面可能有没记下的内容）（2026-10-27 注：负责人不在时按推荐定，待复核）。
4. **恢复后快照** Q：在同一个作业里再拍一张。P 到 Q 这一段里 R 的文件是这次恢复，**不记给任何人**；同一工作路径上别的用户会话这时还在跑时，
   这一段里其余的文件照常记给它们（§4.5 第 2 步）。时间线照常往后走。
5. 写 ref：`rewind/<条目 id>/` 下的 P、Q。条目 id 要等 §5.9 写下 `mori.rewind` 才有，所以 ref 在写条目之后建（同一个作业里）。
6. 之后照 §3.5 刷新 git 状态。

### 5.8 恢复对话

- `AgentSession.navigateTree(targetId, options?) → Promise<{ editorText?, cancelled, aborted?, summaryEntry? }>`（`app/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts:865-876`）。
  传 M 的条目 id、不带 `summarize`（不发模型请求）：M 是你的消息，pi 把叶子移到 M 的父条目（M 是第一条时为根，`resetLeaf`），返回 M 的文字 `editorText`
  （`app/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:3336-3340`、`:3362-3364`）；留在同一个会话文件里，后面的轮次成为一个分支，界面按当前分支显示（同现在）。正在生成或压缩时 pi 抛错（`:3233-3238`），
  §5.5 的检查已经排除这两种情况。
- M 恰好是当前叶子（它之后什么都没写下，例如后台进程在写下回复之前崩溃）时 pi 什么都不做（`:3240-3243`）：这时改为传 M 的父条目。父条目是助手消息、
  自定义条目时 pi 把叶子设到它；是 user 消息、`custom_message`（pi 会再退一步）或没有父条目时，恢复对话失败，原文 `This message has no reply to rewind.`
  （只恢复对话时命令失败；同时恢复代码时进 `warning`，见下一条）。父条目的类型在调用 pi 之前用 `sessionManager.getEntry(M.parentId)` 判断，不靠 pi 的返回。
  这条路上 pi 的返回里没有 `editorText`（目标不是 user 消息，`:3336-3348` 的最后一个分支），`rewind.ts` 自己取 M 的正文放进结果的 `editorText`：字符串正文原样，
  数组取 text 块拼接（把 `app/src/kernel/modelContext.ts:289` 的 `contentText` 导出复用；pi 的 `contentText` 不从包根导出）。
- **再记一次选择范围**（写规格时定的第 7 条，验收 FS-25）：`navigateTree` 成功后，在新的当前分支末尾把这个会话现在的模型选择范围再记一条 `mori.pick`
  （写法同 `app/src/kernel/modelSession.ts:795` 的 `writeEntry`），然后才写 `mori.rewind`（§5.9）。打开会话时范围按当前分支最后一条 `mori.pick` 读
  （`app/src/kernel/modelSession.ts:804-808`，经 `customEntries` 读 `getBranch()`，`:1106-1110`）；不再记一次的话，最后一条可能留在丢掉的分支上，重新打开会话时范围变成更早的那一条。
  `mori.team` 按会话文件的物理行读最后一条、不看分支（`app/src/kernel/team.ts:94-112`），不受影响。模型层规格加注（§18）。
- 先恢复代码、再恢复对话。恢复对话失败时，代码已经恢复的照样写记录，`conversation: false`，结果的 `warning` 为 `Couldn’t restore the conversation: <原文>`。
- 结果带 `editorText` 和 M 的引用（M 的 `mori.ref`，没有为 null）与新的当前分支 `entries`；界面重建对话流，用现有的 `putBackQuoted`（`app/src/renderer/src/state/actions.ts:47-52`：放在已有草稿之前，
  引用芯片放回芯片，全文去掉引用块）把它放回输入框。
- TaskBoard、需求、task、交接都不跟着回退（proposal §13 第 18 条）；分开时立项的“自上次投递以来的对话”找不到旧的 `mori.create_cursor` 时从会话开头带起
  （`app/src/kernel/boardText.ts:1281-1285`，现有行为，上限 12000 字符）。
- 只恢复对话（`code: false`）：不需要快照，不碰文件；git 仍要是 `ok`（§5.5）。

### 5.9 `mori.rewind` 与 Undo

恢复做完后在用户会话里写自定义条目 `mori.rewind`（恢复对话时写在新的叶子之后，所以在新的当前分支上），发同名事件 `{ entryId, record }`：

```ts
/** @brief 一次 Rewind（kind: rewind）或它的 Undo（kind: undo）。 */
interface RewindRecord {
  v: 1;
  kind: 'rewind' | 'undo';
  /** rewind：回到哪条你的消息之前；undo：撤销的那条 mori.rewind 的条目 id */
  target: string;
  /** rewind：M 当时是第几轮（通知里写 turn <n>）；undo 为 null */
  turn: number | null;
  /** 恢复了代码 / 对话 */
  code: boolean;
  conversation: boolean;
  /** 恢复对话前的叶子（Undo 回到这里）；没有恢复对话为 null */
  from: string | null;
  /** 保险快照 P、恢复后快照 Q；只恢复对话时为 null */
  safety: string | null;
  post: string | null;
  /** 恢复的、删掉的、跳过的、失败的文件：各最多 200 个，另记总数 */
  restored: string[]; deleted: string[]; skipped: string[]; failed: { path: string; error: string }[];
  counts: { restored: number; deleted: number; skipped: number; failed: number };
  at: number;
}
```

- **Undo 何时提供**（§17）：一条 `kind: 'rewind'`、`code: true` 的记录，是当前分支上最后一条 `mori.rewind`，没有 `undo` 指向它，它之后当前分支上还没有消息条目
  （你的或程序投递的）；git 是 `ok`。会话忙时同 §5.5 不可点。只恢复对话的 Rewind 没有 Undo。
- **`rewind.undo { sessionId, undoId, conflictChoice? }`**，在工作路径的队列里：
  1. 再拍一张保险快照 P'；
  2. 集合 U = `git diff --name-only -z --no-renames <safety> <post>`（那次恢复实际改了的文件，不受记录里 200 条的限制）与那次恢复的集合取交：记录的 `restored`、`deleted` 没列全时，按那次 Rewind 用的分支上的 `mori.turn_changes` 重算 F、去掉列出的跳过与失败的文件；还是说不准的文件按 `overlap` 冲突问你；P→Q 里别的会话改的文件不动（2026-10-27 注：负责人不在时按推荐定，待复核）；
  3. 冲突 = U 里在 `post` 之后又变了的（`git diff --name-only -z --no-renames <post> <P'>` 与 U 取交集），原因 `changed`；冲突的处理同 §5.6 第 5、6 步；
  4. 从 `safety` 恢复：U（冲突选了 `skip` 时去掉冲突）里 `safety` 没有的先删掉，再把 `safety` 有的 `git restore --source=<safety>`（先删再恢复，同 §5.7 第 2 步的理由）；
     再拍 Q'；P' 到 Q' 这一段同 §5.7 第 4 步（恢复动过的文件不记给任何人）；
  5. 那次 Rewind 恢复了对话（`from` 不为 null）：`navigateTree(from)`（`from` 是当时的叶子，通常是 `mori.turn_changes` 等自定义条目或助手消息，pi 把叶子设到它；
     万一是 user 消息或 `custom_message`，pi 会回到它之前（`app/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:3336-3345`），这时不导航，只恢复代码，`warning` 为
     `Couldn’t restore the conversation: Mori can’t return to where it was before the rewind.`）；导航成功后同 §5.8 再记一条 `mori.pick`；
     这里的目标不是 user 消息，pi 不返回 `editorText`，Undo 结果的 `editorText` 为 null（输入框不变，fs-rewind.md）；
  6. 写 `kind: 'undo'` 的记录（在 Undo 之后的叶子上）。
- 结果与 `rewind` 相同（§5.11）。之后不再提供 Undo（不做 Redo）。

### 5.10 进行中

- Rewind / Undo 从开始到返回，会话处在“正在 Rewind”：`session.prompt` 拒绝，原文 `This session is rewinding. Send your message when it’s done.`；
  这时再来的 `rewind`、`rewind.undo` 也拒绝，原文 `This session is already rewinding.`（界面这时按钮本来不可点）；
  界面在对话流末尾显示 `Rewinding…` / `Undoing…`，发送按钮不可用。
- 它不改 `TeamState.busy`；后台实例不会在这时开始（没有在运行的 Agent 就没有交接和调度，§5.5）。

### 5.11 命令与结果

```ts
/** @brief rewind 与 rewind.undo 的结果；不能做时命令失败，错误原文见 §5.5–§5.9。 */
type RewindResult =
  | { kind: 'conflicts'; conflicts: { path: string; reason: 'changed' | 'overlap' }[]; total: number; token: string }
  | { kind: 'done'; entryId: string; record: RewindRecord; editorText: string | null; refs: QuoteRef[] | null;
      entries: SessionEntry[] | null; warning: string | null };
```

- `conflicts` 按路径排序，最多 200 条，`total` 为全部；`conflictChoice` 为 `{ action: 'overwrite' | 'skip', token: string }`，`token` 原样带回上一次结果里的（§5.6 第 5 步）。
  `skip` 跳过的是全部冲突，包括没列出来的。
- `entries`：恢复了对话时为新的当前分支（同 `session.open` 的 `entries`），否则 null。
- 错误原文（命令失败的 message）：`This session is still running. Stop it first.`、`This message isn’t in the conversation.`、`This message has no code snapshot.`、
  §4.7 的整理原文、`Snapshots are paused for this folder, so code can’t be restored.`、`Git is required to track changes and rewind.`、§5.5 协作模式的原文、
  `This rewind can no longer be undone.`、`This session is already rewinding.`、`Couldn’t take a snapshot: <原文>`（保险快照没拍成）、
  `This message has no reply to rewind.`（只恢复对话、§5.8 的叶子情况）、git 与文件系统的原文。界面显示为 `Couldn’t rewind: <原文>` / `Couldn’t undo: <原文>`。

§6–§10 在 [file-system-permissions.md](file-system-permissions.md)。

## 11. worktree 与 Initialize git

实现 proposal §1 第 5 条、§4（工作路径、主文件夹、worktree 会话）、§5.4、§6（输入框下一行、设置）、§7（`session.prompt { worktree }`、
`workspace.initGit`、`worktrees.cleanUp`）、§8 的 worktree 一行，§12 第 5、6、11 条，§13 第 8–13 条。代码都属于方案第 6 节新增的第 9 件“工作区”。
本节的 git 调用都经 §3 的 `kernel/git.ts`（显式参数与环境、超时、输出上限、同一仓库排队），从不改 `process.env`。
屏幕状态表在 [docs/v1/screens/fs-worktree.md](../v1/screens/fs-worktree.md)。

### 11.1 现在的代码（开工前核实）

| 事实 | 出处 | 影响 |
| --- | --- | --- |
| 新会话的标签一打开就建 pi 会话：`createSessionIn` 先加标签，再发 `session.create`；后台进程 `pi.SessionManager.create(cwd)` | `app/src/renderer/src/state/projects.ts:100-112`；`app/src/kernel/sessions.ts:552-558` | cwd 在第一条消息之前就定了，所以要在发第一条消息时重建（§11.5） |
| pi 的会话文件放在 `<agentDir>/sessions/--<编码后的 cwd>--/<时间>_<id>.jsonl`；第一条你的消息或助手回复写入时才建文件，之前的条目（模型、思考、自定义条目）都在内存里，到那时一起写出 | `app/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:290-295,691-716,791-814` | 重建后会话文件换到 worktree 的目录下；在重建后的会话里写的 `mori.worktree` 随第一条消息一起写出 |
| `SessionManager.create(cwd, sessionDir, { id })` 可以指定 id | `app/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:1316-1319`（`newSession` 校验 id：`:691-695`） | 重建时 pi 会话 id 不变 |
| 现成的“还没写盘的会话用同一个 id 重新建立”：拒绝启动卡的 Check again 先 `closeEntry`，再 `SessionManager.create(entry.cwd, undefined, { id: sessionId })`、`startUser`，沿用信任结果 | `app/src/kernel/sessions.ts:1295-1313` | §11.5 照这条路做，另外换 cwd、沿用发消息前选好的设置 |
| 重建会丢掉内存里的设置：批准状态每次 `new ApprovalPolicy()`；选择范围是 `mori.pick` 条目，思考强度、协作模式（`mori.team` 条目）、会话名也都只在旧的 SessionManager 里 | `app/src/kernel/sessions.ts:482-486`；`app/src/kernel/modelSession.ts:913-915`；`app/src/kernel/sessions.ts:1206-1212`；`app/src/kernel/team.ts:1572-1588` | §11.5.4 列出要沿用的几项 |
| 准备中失败的 `mori.prompt_error` 带 `text`、`refs` 时，界面撤回先显示的消息，把文字和芯片放回输入框，再显示一张不带“放回输入框”的错误卡 | `app/src/renderer/src/state/actions.ts:294-312`；`app/src/renderer/src/state/transcript.ts:342-353` | 建 worktree 失败沿用这条路（§11.5.7） |
| 引用块在你的文字之前，段之间空一行；引用块里没有空行（空行写成 `>`） | `app/src/renderer/src/state/quoteText.ts:58-66` | 取名时跳过前 `refs.length` 段（§11.2） |
| 打开已保存的会话时文件夹不在就报 `Project folder not found: <cwd>` | `app/src/kernel/sessions.ts:627-635` | worktree 不在时先从分支检出（§11.9.4） |
| 侧栏按 `row.cwd` 原样分组，组名是最后一段文件夹名 | `app/src/renderer/src/components/sessionRows.ts:122-127`；`app/src/renderer/src/components/SessionTree.tsx:137-139` | 改成按主文件夹（§11.7） |
| “New session”（Ctrl+N）在当前会话的 cwd 里新建 | `app/src/renderer/src/state/projects.ts:121-128` | worktree 会话里按 Ctrl+N，新会话也在这个 worktree 里（§11.4 第 3 行） |
| 按 cwd 精确算项目的地方：记忆的项目目录（含编码冲突的检查 `projectOwnerError`、写用户级时跳过本项目、`mori.memory_changed` 的 `cwd`）、增强读哪些会话、反馈、模型层的项目访问与 `.mori/models.json`（含 Project access 从会话列表收集的项目）、角色 `.mori/agents`、界面的记忆页跟随的项目与本次信任回答 | `app/src/kernel/memory.ts:361-370,807-810,875`；`app/src/kernel/memoryFiles.ts:35-36`；`app/src/kernel/enhanceRun.ts:226`；`app/src/kernel/feedbackRead.ts:53`；`app/src/kernel/modelLayer.ts:419-440,499`；`app/src/kernel/modelSession.ts:775`；`app/src/kernel/roles.ts:494-495`；`app/src/renderer/src/state/memory.ts:172-177,496-501`；`app/src/renderer/src/components/ChatPane.tsx:102`；`app/src/renderer/src/components/BlockedCard.tsx:66`；`app/src/renderer/src/state/trust.ts:11-13,45-52` | §11.7 逐条改 |
| 引用块标题里的文件路径按标签的 cwd 写（工作路径里的写相对路径，`displayPath`）；界面显示你的消息时按标签现在的 cwd 重新拼引用块、与原文比对，对不上就按原文显示（引用块整个露出来） | `app/src/renderer/src/state/quoteText.ts:44-66`；`app/src/renderer/src/components/toolTitle.ts:29-34`；`app/src/renderer/src/components/Transcript.tsx:72-77` | 第一条消息带文件引用时，重建后 cwd 换了，要把芯片的路径换进 worktree（§11.5.5） |
| git 状态每读一次就发给这个工作路径上所有开着的用户会话；`repoInfo` 不缓存，快照的 `info/exclude` 每次拍之前按这一刻的 `repoInfo` 重新生成 | 本规格 §3.4 第 6 条、§3.5、§4.3 | Initialize git 后同一文件夹里的会话一起变；快照从下一张起按 git 仓库排除（§11.11） |
| 项目级 MCP 服务在会话 cwd 里运行，共享键含运行目录；用户级的在 home 里运行、各会话共用 | `app/src/kernel/mcpShare.ts:213-217,755-760` | worktree 会话的项目级 MCP 服务各起一份（§11.8） |
| pi 的 AGENTS.md 沿上层目录找；嵌在仓库里的 worktree 有自己的一份时不再读主仓库那份；`trust.json` 按最近的上层记录 | `app/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js:136-197`；`app/node_modules/@earendil-works/pi-coding-agent/dist/core/trust-manager.js:18-38` | worktree 放在仓库里，pi 自己就处理好（§11.8） |
| 归档、删除、草稿按会话文件；已归档列表在界面的 `localStorage`（`mori.archived`） | `app/src/renderer/src/state/projects.ts:226-263`；`app/src/renderer/src/state/archive.ts:1-25` | 设置页清理要界面把已归档的会话文件交给后台进程（§11.10） |

**实测（2026-10-26，本机 git 2.55.0.windows.5，临时目录里的仓库）**

| 做法 | 结果 |
| --- | --- |
| 仓库里有超过 260 个字符的路径，`git worktree add` 不带 `-c core.longpaths=true` | 失败：`Filename too long`；带上就成功，之后 `git status` 干净 |
| 上面失败的那次 `worktree add -b t1` | worktree 没建成，**分支 t1 已经建了** |
| 在主仓库里 `git worktree remove` 一个有长路径的 worktree，不带 `-c core.longpaths=true` | 登记删了，长路径的文件**留在磁盘上**（`failed to delete … Filename too long`）；带上就删干净 |
| 手工删掉 worktree 文件夹后，向同一路径 `worktree add` | 失败（已登记）；先 `git worktree prune` 再 add 就成功 |
| `git worktree add` 检出中途被结束（模拟超时：2 万个文件的仓库，150 ms 后结束进程，审查时实测） | 留下 `.git/worktrees/<名字>/locked`（内容 `initializing`），分支已建；`worktree remove --force` 拒绝（`cannot remove a locked working tree`）；`--force --force` 删了登记里的 `gitdir`、`locked`，但文件夹和登记目录没删干净（`Directory not empty`）；之后 `git worktree prune` 删掉登记，文件夹要另外删，`branch -D` 成功 |
| `git worktree add <路径> <已在别的 worktree 检出的分支>` | 失败：`'<分支>' is already used by worktree at …` |
| `git worktree add <路径> <不存在的分支>` | 失败：`fatal: invalid reference: <分支>` |
| worktree 里只有被忽略的文件（`.work/` 里的草稿、`*.log`）时不带 `--force` 的 `worktree remove` | `git status --porcelain` 为空，删除成功，被忽略的文件一起删掉；分支留着 |
| Mori 仓库的本地克隆（788 个已跟踪文件，放在 `%TEMP%`）里 `worktree add` / `worktree remove` | 1.27 s / 0.69 s |
| 空仓库里 `git commit --allow-empty -m "Initial commit"` | 成功，仓库有了第一个提交 |

### 11.2 名字、分支、位置、从哪里切出

**名字**（临时默认值）。取第一条消息里你写的字：`session.prompt` 的 `text` 按 `\n\n` 分段，跳过前 `refs.length` 段（引用块，§11.1），剩下的接起来。然后：

1. Unicode NFKD 分解，去掉附加符号（é → e），转小写；
2. 按不是 `a-z0-9` 的字符切成词，丢掉空词；
3. 从头取词，最多 5 个，用 `-` 连起来、总长不超过 30 个字符（第一个词就超过时截到 30 个字符）；
4. 一个词也没有（例如全是中文、只有引用芯片）时用 `session`；
5. 后面接 `-` 和 6 个小写十六进制字符（`crypto.randomBytes(3)`），照 Claude 的 `<名字>-<6hex>`（u-a8 事实 96）。

例：“Fix the login redirect bug in auth.ts” → `fix-the-login-redirect-bug-3fa9c1`；“修一下登录” → `session-08d2e4`。
名字只用 `a-z0-9-`，所以分支名总是合法的；带后缀也就不会正好是 Windows 的保留名（`con`、`nul` 等）。

**分支** `mori/<名字>`，从下面的“切出点”新建。

**位置**：`<R>/.mori/worktrees/<名字>`。

| 会话是在哪里打开的 | R | 会话的新工作路径 | 主文件夹（§11.3） |
| --- | --- | --- | --- |
| 仓库根（通常的情况） | 这个文件夹 | `<R>/.mori/worktrees/<名字>` | 这个文件夹 |
| 仓库里的子文件夹 `<仓库根>/<sub>` | 仓库根 | `<R>/.mori/worktrees/<名字>/<sub>` | 你打开的子文件夹 |
| Mori 的 worktree 里（`<X>/.mori/worktrees/<a>[/<sub>]`，例如在 worktree 会话里按了 Ctrl+N） | X（不在 worktree 里再套一层） | `<X>/.mori/worktrees/<名字>[/<sub>]` | `<X>[/<sub>]` |

- 子文件夹一行是写规格时定的（§0“写规格时定的”第 5 条；proposal 只写了仓库根的情况）：侧栏仍归在打开的那个子文件夹下。`<sub>` = `path.relative(仓库根, cwd)`，仓库根取 §3 的 `repoInfo`。
- R **从会话 cwd 的字符串推出**（去掉末尾 `<sub>` 那几段），不用 git 输出的写法（git 给的是 `/` 分隔、大小写可能不同）。
  这样 worktree 会话的主文件夹与主文件夹里的会话 cwd 是同一个字符串，侧栏分组、记忆目录名都对得上。
- 别的工具建的 worktree（例如 Claude 的 `.claude/worktrees/x`）不是 Mori 的 worktree，按第一行处理：R 就是它自己（它是自己那个 worktree 的仓库根），主文件夹是它自己。

**切出点**：会话所在文件夹的 HEAD（`git rev-parse --verify HEAD^{commit}`，在会话 cwd 里跑），不联网（proposal §13 第 9 条）。
在主文件夹里开的会话（通常的情况），这就是 §13 第 9 条的“主文件夹当前分支的 HEAD”。
在 Mori 的 worktree 里开的会话从那个 worktree 的 HEAD 切出，照 Claude 的 fork：从分支的最新提交切出，那个 worktree 里没提交的改动不带过来
（u-a7 事实 72）。这是写规格时定的（§0“写规格时定的”第 6 条）：从你开会话的那个文件夹当前的 HEAD 切出，proposal §13 第 9 条的“主文件夹当前分支的 HEAD”按此理解。

**撞名**：`<R>/.mori/worktrees/<名字>` 已存在，或 `git show-ref --verify --quiet refs/heads/mori/<名字>` 成功时，换一个后缀重来，最多 3 次；
都撞上时失败（§11.5.7），原文 `<路径> already exists.`（临时默认值）。

### 11.3 按路径认主文件夹：`worktreeOf` 与 `projectFolder`

`shared/workspace.ts` 里两个纯函数（界面和后台进程都用，不调 git、不读文件）：

```ts
/** @brief Mori worktree 里的路径：worktree 根、它所在仓库的 R、名字、分支、主文件夹；不在 Mori worktree 里时为 null。 */
export function worktreeOf(cwd: string): { root: string; path: string; name: string; branch: string;
  mainFolder: string } | null;
/** @brief 会话按哪个文件夹算项目：Mori worktree 里时为主文件夹，否则为 cwd 本身。 */
export function projectFolder(cwd: string): string;
```

- 规则：把 cwd 按 `\` 和 `/` 切段，从左找第一处连续三段 `.mori`、`worktrees`、`<名字>`（前两段不分大小写；`<名字>` 只含 `a-z0-9-`，即 §11.2 取出的名字，别的不算）。找到时
  `root` = 前面的部分（R），`path` = `<R>\.mori\worktrees\<名字>`，`branch` = `mori/<名字>`，`mainFolder` = R 接上 `<名字>` 之后剩下的段；没找到时为 null。
  结果保留 cwd 原来的写法（分隔符换成 cwd 里用的）。
- 这条规则成立，是因为 Mori 只在 `<R>/.mori/worktrees/<名字>` 建 worktree、分支总是 `mori/<名字>`（§11.2），而 `.mori` 是受保护路径（§6），Agent 不会不经你同意在那里建别的。
- 分支取的是建 worktree 时的名字，不读 git；Agent 在 worktree 里换了分支，侧栏的标签不跟着变（右栏的 git 状态显示当时的分支，§3）。
- §3 的 `RepoInfo` 不给主文件夹（§3.4 第 5 条）：本节和 §11.7 一律用 `projectFolder(cwd)`，不调 git。git 给出的主检出在子文件夹里开的 worktree 会话上
  与 `projectFolder` 不同（`<R>` 对 `<R>\<sub>`），在 Claude 的 `.claude/worktrees/x` 上也不同（git 给主检出，这里给它自己）。

| cwd | `projectFolder` | 分支标签 |
| --- | --- | --- |
| `D:\work\tool` | `D:\work\tool` | — |
| `D:\work\tool\.mori\worktrees\fix-login-3fa9c1` | `D:\work\tool` | `mori/fix-login-3fa9c1` |
| `D:\work\tool\.mori\worktrees\fix-login-3fa9c1\app` | `D:\work\tool\app` | `mori/fix-login-3fa9c1` |
| `D:\work\tool\.claude\worktrees\x` | `D:\work\tool\.claude\worktrees\x` | — |

### 11.4 Worktree 开关与 Initialize git… 什么时候出现

都在输入框下一行，紧跟在权限按钮之后、和它一起靠左（proposal §6“左端是权限……旁边是 Worktree 开关”）；现在把右边一组推开的是
`.composer-bottom > .permission + * { margin-left: auto; }`（`app/src/renderer/src/styles/chat.css:358`），改成开关后面那一项带它（`app/src/renderer/src/components/Composer.tsx:272-287`）。新组件 `WorktreeToggle.tsx`。条件都要满足：会话已打开（不在“Starting…”）、
还没有你的消息（同右键菜单的 `isUnsaved`，`app/src/renderer/src/components/sessionRows.ts:74-76`）、不在发送中或运行中（`transcript.sending`、`transcript.running` 为假）、
这个会话还没有自己的 worktree（`SessionInfo.worktree` 为 null，§11.6）、不在建 worktree 中（§11.5.6）。来源是这个会话最近一次的
`mori.workspace_status`（§3.5 的 `WorkspaceStatus`：`git.state`、`repo`、`repo.hasCommit`、`error`）；还没到时两样都不显示。

| git 状态（`WorkspaceStatus`） | 显示 |
| --- | --- |
| `git.state` 为 `ok`，`repo.hasCommit` 为真 | `Worktree` 开关，默认关（照 Claude，proposal §12 第 5 条） |
| `repo` 不为 null、`hasCommit` 为假（还没有提交） | 两样都不显示（proposal §13 第 13 条） |
| 同第一行，会话在 Mori 的 worktree 里（例如在 worktree 会话里按 Ctrl+N 新建的会话） | `Worktree` 开关；打开后从这个 worktree 的 HEAD 切出新的 worktree（§11.2） |
| `git.state` 为 `ok`、`repo` 为 null、`error` 为 null（不是 git 仓库） | `Initialize git…`（§11.11） |
| `error` 不为 null（例如 `detected dubious ownership`） | 两样都不显示（右栏显示原文，§5） |
| `git.state` 为 `missing` 或 `old` | 两样都不显示；右栏写明 Git is required（§5） |

**窄栏**（临时默认值，补 [v0 models.md](../v0/screens/models.md)“窄栏”）：这一栏 ≤ 460px 时（权限、范围、Effort 去掉 ▾ 的同一档）开关和 `Initialize git…`
只显示新图标 `branch`（`icons.tsx`），名字在读屏名和悬停第一行里；这一项从不截短，放不下时照 models.md“放不下”的次序截别的项。
只在第一条消息之前出现，这时这一行没有 Stop、Queue，不比生成中更挤。

- 开关只是这个标签在界面里的状态（`Tab.worktreeOn`），不发命令，不存盘；发第一条消息时随 `session.prompt` 带上（§11.5）。
- 第一条消息发出后（成功），或者会话有了自己的 worktree（第一条消息没能写进会话时也是，§11.5.7 最后一行），开关不再出现。

### 11.5 第一条消息时建 worktree

#### 11.5.1 命令

`session.prompt { sessionId, text, refs?, team?, worktree?: boolean }`。`worktree` 只在开关打开时由界面带 `true`；只对第一条消息有效。
结果在现在的 `{ accepted: true, held }` 上加 `session?: SessionInfo`：带了 `worktree: true` 时总有，是重建后（或失败后在原文件夹重建的）会话信息。
界面用 `withInfo` 记到同一个标签上（同 Check again，`app/src/renderer/src/state/modelActions.ts:148-160`）。

#### 11.5.2 前提（后台进程在做任何 git 操作之前检查，不满足时按 §11.5.7 失败）

| 检查 | 不满足时的原因原文 |
| --- | --- |
| 会话被拒绝启动（`model.isBlocked()`） | 同现在：`BLOCKED_PROMPT_MESSAGE`，不建 worktree |
| 会话里还没有你的消息或助手回复，`entry.worktree` 为 null；没带 `behavior` | `This session already has messages.` |
| 会话空闲：不在准备中、不在运行，Team 不忙（同 `closeSession` 的检查，`app/src/kernel/sessions.ts:810-816`） | `This session is still running. Stop it first.`（现有原文 `GENERATING`） |
| §3 的 `git.state` 为 `ok` | `Git is required to create a worktree.` |
| cwd 在 git 仓库里（`repoInfo` 不为 null、没有错误），HEAD 有提交 | `This folder isn’t a git repository.` / `This repository has no commits yet.` / `repoInfo` 的错误原文 |
| 工作路径是仓库的子文件夹时，`<sub>` 在切出点的树里：`git cat-file -e <切出点>:<sub 用 / 写>` 退出码 0（还没提交的子文件夹检出后不存在，会话会建在一个不存在的 cwd 上） | `The folder <sub> isn’t committed yet, so a worktree can’t start there. Commit it first.` |

看不见的增强会话不经界面的命令（`requireEntry` 不认它，`app/src/kernel/sessions.ts:740-751`），它的 `promptEntry` 也从不带 `worktree`，不另查。

#### 11.5.3 git 步骤（`kernel/workspace.ts` 的 `createWorktree(cwd, ownText, timeoutMs = 120_000)`，按顺序；超时从参数传入，测试用，默认见 §17）

1. `repoInfo(cwd)`（§3）取仓库根；按 §11.2 算 R、`<sub>`、名字、路径、分支，切出点 `git rev-parse --verify HEAD^{commit}`。然后两项检查，不满足时不做任何 git 改动，按 §11.5.7 失败：
   - 工作路径是子文件夹时，§11.5.2 表最后一行的 `git cat-file -e <切出点>:<sub>`；
   - `git config --local --get core.worktree`（共用的 `.git/config`，在会话 cwd 里跑）有值 → 原因 `This repository sets core.worktree, so Mori can’t create a worktree here. Move it to the main worktree’s config.worktree first.`
     （复核时在 2.55 上实测：这时链接出去的 worktree 以主文件夹为工作树，在里面 `add`、`commit` 改的是主文件夹和它的 index，连 `.mori/worktrees/<名字>` 都会被当成嵌套仓库提交）。
2. `git config --get extensions.worktreeConfig` 不是 `true` 时 `git config extensions.worktreeConfig true`（写共用的 `.git/config`；Claude 桌面版同样，u-a8 事实 96）。
3. `git rev-parse --path-format=absolute --git-path info/exclude`（从 worktree 里跑也指向共用的 common dir，u-a8 事实 85）；文件里没有一行（去掉首尾空白后）等于
   `.mori/worktrees/` 时在末尾加这一行（没有 `info` 目录就建）。写法照 Claude 的 `.claude/worktrees/`（u-a8 事实 84）。在 `worktree add` 之前做，主文件夹的 git 状态里从不出现它。
4. `git -c core.longpaths=true worktree add -b mori/<名字> <路径> <切出点>`（实测：不带 `-c` 时长路径检出失败，§11.1）。超时 120 s（临时默认值）。
5. `git -C <路径> config --worktree core.longpaths true`（写 `.git/worktrees/<名字>/config.worktree`；第 2 步之后 `--worktree` 才不写进共用配置）。
   这只管 git 自己；`node_modules` 这类由 npm 等写的目录仍受 Windows 的 LongPathsEnabled 限制（proposal §13 第 8 条）。
6. 在新的工作路径里调 §7.10 的 `ensureWork(cwd)`（写内容为 `*` 的 `.work/.gitignore`）：它没被跟踪，不会随检出出现（u-a8 事实 83）。
   §7.10 本来在第一次放行命令时才建，这里先建一次，结果相同。
7. 返回 `{ root, path, branch, mainFolder, cwd }`（`cwd` = `<路径>[/<sub>]`）。

第 4 步开始之后任何一步失败（含第 4 步自己失败或超时），按顺序清理，每一步失败只记日志、接着做下一步：
1. `git -c core.longpaths=true worktree remove --force --force <路径>`：两个 `--force` 是因为超时被结束的 `worktree add` 留下锁（§11.1 实测）；
2. `git worktree prune`（上一步没删干净时登记还在）；
3. `<路径>` 还在就删掉这个文件夹（它是这次刚建的：第 1 步撞名检查时还不在）；
4. `git branch -D mori/<名字>`（第 4 步失败也可能已经建了分支，实测；这个分支是这次刚建的、指向切出点、没有别的提交）。

然后按 §11.5.7 报告。第 2、3 步写的配置和 exclude 行不撤（以后还要用，留着无害）。

#### 11.5.4 重建会话（`kernel/worktreeSession.ts` 的 `startInWorktree`，照 Check again；`closeEntry`、`startUser` 由 `kernel/sessions.ts` 传入）

1. 记下要沿用的（下表），`closeEntry(旧的)`。
2. `pi.SessionManager.create(新 cwd, undefined, { id: 原 id })`，紧接着 `appendCustomEntry('mori.worktree', { path, branch, mainFolder })`（§11.6）。
3. `startUser({ cwd: 新 cwd, sessionManager, emit: 原 emit, trust: undefined, restored: false, decision: 旧的信任结果, approval: 旧的 ApprovalPolicy })`；
   `UserStart` 加可选的 `approval`（省略时同现在 `userApproval`）。重建后的会话用的是原来那一份批准状态（模式、按工具名与按目录的放行，§6），
   是同一个 `ApprovalPolicy` 对象，不是重新建一份；失败后在原文件夹重建时也一样（§11.5.7）。
4. 在新会话上把记下的设置设回去（与新会话的默认相同的不设），按这个顺序：选择范围、思考强度、会话名、最后协作模式
   （协作模式打开后范围被锁定，`setPick` 会拒绝，`app/src/kernel/modelSession.ts:913-915`）。
5. 后台进程为新的工作路径读一次 git 状态（§3.5，发给这个工作路径上开着的用户会话）。界面在建 worktree 中不发 `workspace.status`（§11.5.6）。

| 项 | 怎样 |
| --- | --- |
| pi 会话 id | **不变**（`{ id }`）；界面的标签（`tab.key`）不变；TaskBoard 目录 `teams/<id>` 按 id，不变 |
| 工作目录 | 换成 §11.2 的新工作路径 |
| 会话文件 | 换成 `<agentDir>/sessions/--<新工作路径编码>--/<时间>_<id>.jsonl`（pi 的规则），第一条消息写入时才建；界面的 `tab.sessionFile` 由结果的 `withInfo` 换掉。草稿按会话文件存（`app/src/renderer/src/state/drafts.ts:60-86`），会话文件一换就存到新的键下，不另做 |
| 信任 | 沿用这次打开时的判断（同 Check again）：worktree 只检出已提交的文件，是你打开的文件夹已提交内容的一部分（子文件夹的情况是同一个子文件夹） |
| 权限模式、“Allow for this session”、按目录放行（§6） | 沿用同一个 `ApprovalPolicy` 对象（第一条消息之前后两样通常是空的） |
| 选择范围 | 旧会话最后一条 `mori.pick` 与新会话不同时 `model.setPick(旧的)` |
| 思考强度 | 不同时 `session.setThinkingLevel(旧的)`，再 `model.emitState()` |
| 协作模式 | 旧的是 `always` 时新会话的 Team `setMode('on')`（第一条消息之前只会是 off 或 always） |
| 会话名 | 你在第一条消息前改过名时 `setSessionName(旧的)` |
| 角色 | 重新读，从主文件夹的 `.mori/agents` 读（§11.7），与旧的相同 |
| 扩展的通知、增强提示 | 同 Check again：新会话打开时的扩展通知不再显示；界面上的增强提示照旧（`withInfo` 在不是“opening”时保留它，`app/src/renderer/src/state/projects.ts:42-49`） |

#### 11.5.5 发出消息与结果

重建后对新会话 `promptEntry(新的, text, { behavior, refs: 换过路径的 refs, team })`（不带 `worktree`）：之后与现在完全一样（准备中、选模型、协作模式下交给 Team）。
命令的结果在 `dispatch` 之后返回，带新会话的 `SessionInfo`。新会话先发出的事件（模型状态、你的消息）可能比结果早到；会话 id 没变，界面照常按 id 交给这个标签。

**文件引用换进 worktree**（临时默认值）：`text` 里的引用块是界面按原来的 cwd 拼的，工作路径里的文件写成相对路径（`Quoting src/a.ts, lines 3–5:`，§11.1）。
重建后标签的 cwd 换成 worktree，界面按新 cwd 重拼时对不上，你的消息会连引用块一起露出来；模型按新 cwd 读 `src/a.ts` 时读到的也是 worktree 里那份。
所以交给 `promptEntry` 之前，`refs` 里 `kind: 'file'`、`path` 在原来的 cwd 里的，`path` 换成新 cwd 下同样的相对路径（`path.relative` 之后接到新 cwd 上，
大小写与分隔符按新 cwd）；工作路径外的、`message` 与 `session` 引用不动。`text` 不改（相对路径的写法换前换后相同），所以发给模型的文字不变；
`mori.ref` 条目与 `mori.entry_id` 带的是换过的 `refs`，界面按新 cwd 认得出引用块。换法是 `shared/workspace.ts` 的纯函数 `refsInto(refs, from, to)`，
界面拿到结果、用 `withInfo` 换 cwd 的同时，也用它换掉先显示的那条消息的 `refs`（不然在 `mori.entry_id` 到之前会闪一下原文）。引用的原文（`quote`、`sha256`）是你在主文件夹看到的那份，
worktree 里那个文件可能不同（没提交的改动不带过来）；点芯片打开的是 worktree 里的文件。

#### 11.5.6 进行中

- 后台进程：从开始检查到 `promptEntry` 交出，会话 id 记在 `creatingWorktree` 集合里。`requireEntry` 与 `renameSession`（它用 `visibleEntry`）先查这个集合，在里面时抛 `The worktree is still being created.`，
  所以这期间这个会话的其他命令（发消息、停止、改名、关闭、换权限、范围、Effort、协作模式、Check again）都拒绝；建 worktree 不能中途取消（临时默认值）。
- 界面：从发出带 `worktree: true` 的 `session.prompt` 到拿到结果，你的消息先显示（同现在），阶段行 `Creating worktree…`；
  输入框里可以继续打字，但不能发送；Stop、输入框下一行的按钮和顶栏的协作开关不可用，悬停 `Creating worktree…`（临时默认值，与后台进程的拒绝一致）；
  不为这个标签发 `workspace.status`（切到它、窗口回到前台时也不发），git 状态由后台进程在建好后发（§11.5.4 第 5 步）。

#### 11.5.7 失败

| 失败在哪一步 | 会话 | 界面 |
| --- | --- | --- |
| §11.5.2 的检查（被拒绝启动时同现在，不加前缀）、§11.5.3 第 1 步的两项检查（`The folder <sub> isn’t committed yet…`、`This repository sets core.worktree…`）与 git 步骤 | 没动：仍是原文件夹里那个空闲的会话；建了一半的 worktree 和分支已撤掉 | 旧会话发 `mori.prompt_error { message: 'Couldn’t create the worktree: <原因或 git 原文>', text, refs, running: false, queued: [] }`：你的消息撤回，文字和芯片回到输入框，一张错误卡显示这句；开关仍然开着 |
| §11.5.4 重建（必需的扩展没加载上等） | 按 §11.5.3 的清理撤掉刚建的 worktree 和分支，在原文件夹按原 id 再建一次（同样沿用设置），由它发上面那条 `mori.prompt_error`；结果的 `session` 是它的信息 | 同上 |
| 在原文件夹也建不起来 | 命令失败，后台进程里没有这个会话了 | `send()` 照现有的命令失败处理（错误卡带 “Put your last message back in the message box”，`app/src/renderer/src/state/actions.ts:115-119`），并把标签标成打开失败（`markFailed`，`app/src/renderer/src/state/projects.ts:94-97`，改成导出）：横幅 `Failed to open session: <原文>`，会话行 Error；再点会话行时按现有的 `reopen` 在原文件夹新建（`app/src/renderer/src/state/projects.ts:281-302`：会话文件不在、也没有你的消息时新建）。界面不分辨原因：带 `worktree: true` 的 `session.prompt` 只在这一种情况下命令失败（其余各行都由事件报告、命令照常返回），命令失败就按这一行处理 |
| 重建之后（准备中出错、没有可用模型、扩展命令接手没开始运行） | 已在 worktree 里，同现在的准备中失败；你的消息没能写进会话时，会话仍没保存，但已经有自己的 worktree | 同现在；开关不再出现（§11.4） |

### 11.6 `mori.worktree` 条目与 `SessionInfo.worktree`

- **条目**：`mori.worktree` 是用户会话文件里的自定义条目（`appendCustomEntry`，不进模型上下文），数据 `{ path: string /* worktree 根 */, branch: string, mainFolder: string }`，
  zod schema `WorktreeEntrySchema` 在 `shared/workspace.ts`。只由 §11.5.4 写一次。它表示“这个会话**拥有**这个 worktree”：只有拥有它的会话在归档、删除时处理它（§11.9）。
  在 worktree 文件夹里另开的会话（Ctrl+N 且开关关着）没有这一条，它们只是工作路径在那里。
- **读**：`startUser` 从 SessionManager 的条目里取最后一条合法的 `mori.worktree`，记在 `Entry.worktree`；不在文件里读 git。
  没打开的会话从文件里逐行找（照 `savedTeamEntry` 的做法，`app/src/kernel/team.ts:94-112`，但按行流式读：`mori.worktree` 总写在第一条消息之前，
  §11.5.4，所以读到它、或读到第一条 `message` 条目就停，不读整个会话文件），只给 §11.9、§11.10 的命令用。
- **`SessionInfo.worktree: { path, branch, mainFolder } | null`**：`describeEntry` 从 `Entry.worktree` 给出（`app/src/kernel/sessions.ts:211-230`）。界面用它决定开关（§11.4）。
- `SavedSession` 不加字段：侧栏的分组和分支标签都用 `worktreeOf(cwd)`（§11.3），不为列表多读会话文件。两边按构造总是一致（验收 FS-95 断言）。

### 11.7 按主文件夹算项目

proposal §13 第 11 条：worktree 会话的记忆、增强、反馈、模型的项目访问按主文件夹算。做法是在下面每一处先取 `projectFolder(cwd)`；
不在 Mori worktree 里的会话 `projectFolder(cwd) === cwd`，行为不变（子文件夹仍不算同一个项目，记忆规格 §3）。

| 处 | 现在 | 改成 |
| --- | --- | --- |
| 侧栏分组（`app/src/renderer/src/components/sessionRows.ts:122-127` `groupRows`） | 按 `row.cwd` | 按 `projectFolder(row.cwd)`；组名 `folderName(主文件夹)`，悬停主文件夹全路径 |
| 侧栏会话行（`app/src/renderer/src/components/SessionTree.tsx:80-95`） | 会话名、状态 | worktree 里的会话在会话名之后加分支标签（`worktreeOf(cwd).branch`，次要文字色）；悬停 `<会话名> · <分支>`；已归档的行悬停 `folderName(主文件夹) · <会话名>`（worktree 里的再接 ` · <分支>`） |
| 顶栏项目名（`app/src/renderer/src/components/ChatPane.tsx:202`） | `folderName(tab.cwd)`，悬停 cwd | `folderName(projectFolder(tab.cwd))`，悬停仍是 cwd（工作路径） |
| 记忆的项目目录（`app/src/kernel/memory.ts:361-370` `projectDir`、`claimProject`；`app/src/kernel/memory.ts:875` `otherProjects`；`app/src/kernel/memoryFiles.ts:35-36` `projectOwnerError`） | `projectDirName(cwd)`，编码冲突按 cwd 比，`project.json` 记 cwd | `projectDir` 开头取 `folder = projectFolder(cwd)`，目录名和占用检查都按 `folder`（只换目录名的话，`project.json` 记的主文件夹与 worktree 的 cwd 不同，会被当成别的项目占用）；`claimProject` 写 `folder`；`otherProjects` 跳过本项目时也按 `folder`。worktree 会话读写主文件夹的项目记忆；增强提示（`takeNotice`）经 `projectDir`，同样按主文件夹 |
| `mori.memory_changed`（`app/src/kernel/memory.ts:807-810`） | `cwd` 是写入时的 cwd | `cwd` 为 `projectFolder(cwd)`：记忆页按项目比较（`app/src/renderer/src/state/memory.ts:438-440`），worktree 会话的 `memory` 工具写入后主文件夹的记忆页照样刷新 |
| 记忆页跟随的项目（`app/src/renderer/src/state/memory.ts:172-177` `followedOf`、`496-501` `focusProject`；`app/src/renderer/src/components/ChatPane.tsx:102` 增强提示的 View） | 标签的 cwd | `projectFolder(tab.cwd)`（比较时两边都取）：worktree 会话里打开记忆页，Project 一层是主文件夹，旁边写主文件夹名；`enhance.get` 等带的 `cwd` 也就是主文件夹，与增强调度记的项目（`app/src/kernel/enhance.ts:799-803`）对得上 |
| 增强读哪些会话（`app/src/kernel/enhanceRun.ts:226`） | `info.cwd === input.cwd` | `projectFolder(info.cwd) === input.cwd`：主文件夹和它的 worktree 里的会话都读；增强会话自己仍在主文件夹里运行 |
| 反馈（`app/src/kernel/feedbackRead.ts:53`） | `feedback.session.cwd === cwd` | `projectFolder(feedback.session.cwd) === cwd` |
| 模型层（`app/src/kernel/modelLayer.ts:419-440` 的 `registerProject`、`projectContext`；`app/src/kernel/modelLayer.ts:499` 的 `projectAccess`） | 按传入的 cwd；Project access 另把 pi 会话列表里每个会话的 cwd 都当成项目 | 三处开头先取 `projectFolder`：Project access 只列主文件夹（不列 worktree），`projectZones` 按主文件夹，`.mori/models.json` 从主文件夹读（proposal §13 第 10 条） |
| 拒绝启动卡的 allow_zone（`app/src/renderer/src/components/BlockedCard.tsx:66`） | `openModelsSettings({ projectPath: tab.cwd })` | `projectPath: projectFolder(tab.cwd)`：跳到 Project access 里主文件夹那一项 |
| 角色（`app/src/kernel/roles.ts:494-495` `loadRoles`） | `<cwd>/.mori/agents` | `<projectFolder(cwd)>/.mori/agents`（proposal §13 第 10 条）；Team 和它的实例仍在会话的工作路径（worktree）里运行 |
| 界面的本次信任回答（`app/src/renderer/src/state/trust.ts:11-13,45-52`） | `answers`、`pending` 按 cwd | 按 `projectFolder(cwd)`（临时默认值：proposal §13 第 11 条没列信任）：在主文件夹回答过，同一次运行里它的 worktree 不再问 |

记住信任（`app/src/kernel/trust.ts:45-56` `remember`）**不改**，仍写 cwd，查法照 pi（最近的上层记录，`app/node_modules/@earendil-works/pi-coding-agent/dist/core/trust-manager.js:21-34`）：主文件夹是仓库根时，它记住的信任覆盖它的所有 worktree；
在 worktree 会话里勾 Remember my choice 只记那个 worktree。子文件夹的情况（主文件夹 `<R>\<sub>` 不是 worktree `<R>\.mori\worktrees\<名字>\<sub>` 的上层）主文件夹记住的不覆盖 worktree，
重启后打开 worktree 会话会再问一次（同一次运行里由上一行的界面回答带上）。

不按主文件夹的：快照与内部仓库按工作路径（每个 worktree 一个，§4）；`.work` 在工作路径下（§7）；文件阅读器按标签的 cwd 解析路径；
路径闸的“工作路径里/外”按会话 cwd（§6：worktree 会话写主文件夹算写到外面）；TaskBoard 按会话 id。

### 11.8 worktree 里读哪些配置

| 内容 | 从哪里读 | 说明 |
| --- | --- | --- |
| Mori 的 `.mori/agents`、`.mori/models.json` | 主文件夹 | §11.7（proposal §13 第 10 条） |
| pi 的 `.pi/`（设置、扩展、技能、提示词、`mcp.json`）、AGENTS.md、`.agents/skills` | worktree（pi 的 `DefaultResourceLoader` 以会话 cwd 为准） | 不改 pi。worktree 只有已提交的文件，主文件夹里没提交的 `.pi/` 在 worktree 里没有（接受这个差别）；AGENTS.md 由 pi 沿上层找，worktree 有自己的一份时不再读主仓库那份（`app/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js:136-197`） |
| 项目信任 | worktree 的 `.pi/` 决定要不要问；`trust.json` 按最近的上层记录 | worktree 在仓库里，主文件夹是仓库根时它记住的信任覆盖 worktree（`app/node_modules/@earendil-works/pi-coding-agent/dist/core/trust-manager.js:21-34`）；界面的本次回答按主文件夹（§11.7） |
| 项目级 MCP 服务 | worktree 的 `.pi/mcp.json`，在 worktree 里运行 | 共享键含运行目录（`app/src/kernel/mcpShare.ts:213-217,755-760`），每个 worktree 各起一份进程；用户级的服务照旧共用。不改 |
| 受保护路径 | §6 按工作路径里的相对路径判断 | worktree 会话的工作路径本身在 `<R>/.mori/worktrees/` 下，它里面的文件不因为上层叫 `.mori` 而受保护；它里面的 `.git`（worktree 里是一个文件）、`.mori/`、`.pi/` 照常受保护 |

新 worktree 里只有已提交的文件，`node_modules`、`.env` 这类要 Agent 重新装或复制（proposal §5.4）；开关的悬停说明写明（屏幕表）。

### 11.9 归档、恢复、删除，打开 worktree 不在的会话

#### 11.9.1 两个命令（也给 §11.10 用）

- `worktrees.list { sessionFiles: string[] }` → `{ git: boolean; items: WorktreeItem[] }`：只列出拥有 worktree 的会话（§11.6：开着的从 `Entry.worktree`，
  没开着的从文件里找）。界面只交 `worktreeOf(cwd)` 不为 null 的会话文件。每一项：

  | 字段 | 含义 |
  | --- | --- |
  | `sessionFile` | 拥有它的会话 |
  | `path`、`branch`、`mainFolder` | 同 `mori.worktree` |
  | `exists` | 文件夹还在（只说文件夹；登记在不在以 `git -C <R> worktree list --porcelain` 为准） |
  | `changes` | 有未提交或未跟踪的文件（`git --no-optional-locks status --porcelain` 不为空；被忽略的文件不算）；不在、没装 git、读不出时为 null |
  | `inUse` | 除拥有它的会话（和它的实例）之外，有开着的会话的工作路径是它或在它里面 |

- `worktrees.cleanUp { paths: string[]; force: boolean }` → `{ results: { path, removed: boolean, reason: 'changes' \| 'in_use' \| 'missing' \| null, error: string \| null }[] }`。逐个：
  1. `worktreeOf(path)?.path === path`，且在 `git -C <R> worktree list --porcelain` 里（路径比较不分大小写、不分 `\` 与 `/`），否则 `error`（`Not a Mori worktree: <path>`），什么都不删；
  2. 文件夹不在：`reason: 'missing'`；
  3. 有开着的会话的工作路径是它或在它里面：`reason: 'in_use'`，不删；
  4. `force: false` 且 `changes`：`reason: 'changes'`，不删；`force: false` 时读不出改动（git 失败、超时）同样不删，`error` 为 git 的原文（读改动用 `-c status.showUntrackedFiles=normal`，按仓库的 common dir 排队、120 秒）（2026-10-27 注：负责人不在时按推荐定，待复核）；
  5. `git -c core.longpaths=true worktree remove [--force --force] <path>`（实测：不带 `-c` 会留下长路径的文件）：`force: true` 时带两个 `--force`
     （锁着的登记也能删，§11.1 实测；`force: false` 一个都不带）。分支从不删。失败时 `error` 为 git 原文，记日志。
  6. `remove` 成功后 `<path>` 还在（里面有目录联接时 git 只删登记、联接与文件夹留着，复核时在 2.55 上实测，例如 Agent 做的 `mklink /J node_modules …`）→
     `fs.rm(path, { recursive: true, force: true })`（Node 的递归删除不跟进联接，不碰联接指向的目录，实测）；仍在则 `removed: false`、`error` 为原文。

  `.work/` 和 `node_modules` 等被忽略的文件不算改动，删 worktree 时一起删掉（实测）。两个命令都只在你操作时调用，不在后台扫（proposal §9 第 5 条）。

#### 11.9.2 归档

`archiveSession`（`app/src/renderer/src/state/projects.ts:232-237`）：会话是 worktree 里的会话时，先 `worktrees.list { sessionFiles: [它] }`；然后照旧关闭、记进已归档列表；
有拥有的 worktree 时再 `worktrees.cleanUp { paths: [它], force: false }`。干净就删掉、分支留着；有改动、正被别的会话用着、删除失败都留着，等设置页清理。
归档不弹确认，同方案 5.3（proposal §5.4）；`cleanUp` 的结果不显示，只记日志（临时默认值）。

#### 11.9.3 恢复（Unarchive）

只改已归档列表，同现在（`app/src/renderer/src/state/projects.ts:240-244`）。worktree 不在时，在打开这个会话时检出（§11.9.4）；点已归档的会话行是“恢复并打开”，所以当场检出。

#### 11.9.4 打开 worktree 不在的会话

`openFromFile`（`app/src/kernel/sessions.ts:627-635`）在报 `Project folder not found` 之前，`worktreeOf(cwd)` 不为 null 时按它的 `path`（worktree 根）分三种
（不要求有 `mori.worktree`，所以在同一个 worktree 里另开的会话也能把它带回来）：

- 文件夹不在（登记可能还在：手工删掉的，或 `worktree add` 被结束时留下 `locked` 的）→ 按 `path`、`branch` 恢复，下面第 1–4 步；
- 文件夹在，而 `git -C <R> worktree list --porcelain` 里没有它（路径比较同 §11.9.1 第 1 步）→ 打开失败，原文
  `The worktree folder <path> exists but isn’t registered with git. Move or delete it, then open this session again.`（不替你删：里面可能有 `.git` 文件丢了的未提交改动）；
  没装 git 时不查登记，照常打开；
- 文件夹在、登记也在 → 不恢复；只是 cwd 那个子文件夹不在时照现在报 `Project folder not found: <cwd>`。

1. R 不在 → `Project folder not found: <R>`（现有写法）；没装 git → `Git is required to restore this session’s worktree.`；
2. `git -C <R> worktree list --porcelain` 里有这个 `path`（文件夹不在；含登记目录里带 `locked` 的，`worktree add` 被结束时留下）→ 先
   `git -C <R> worktree remove --force --force <path>`（实测：不锁的、文件夹已删的登记同样删掉；`prune` 不删锁着的登记），再 `git -C <R> worktree prune`
   （实测：手工删掉的 worktree 仍有登记，不先清掉就 add 不上）；
3. `git -C <R> -c core.longpaths=true worktree add <path> <branch>`（不带 `-b`，照 Claude：会话恢复时把分支重新检出，u-a7 事实 33）；
   分支不在 → `The branch <branch> no longer exists, so this session’s worktree can’t be restored.`；分支在别的 worktree 里检出着 → git 原文；
   超时 120 s（§17 worktree 的超时）；失败或超时时按 §11.5.3 清理的第 1–3 步（`remove --force --force`、`prune`、文件夹还在就删掉），**不**做第 4 步删分支
   （它不是这次建的），再报打开失败，原文为 git 原文或 `Restoring the worktree timed out after 120 seconds.`；
4. §11.5.3 第 5、6 步（`config.worktree` 的 `core.longpaths`、`ensureWork`）；然后照常打开。

信任：界面在 `session.open` 之前的 `trust.check` 是对着还不在的文件夹问的，看不到 worktree 里的 `.pi/`（`hasTrustRequiringProjectResources` 为假，不问）。
检出之后 `decideTrust` 按 pi 的记录（主文件夹是仓库根、记住过时覆盖）或界面带上的本次回答（§11.7）判断；两样都没有、worktree 里又有要信任的 `.pi/` 内容时，
照现有的做法按 `unasked` 打开（项目资源不加载，`app/src/kernel/trust.ts:68-71`），不另问。

失败时打开失败，界面同现在的“新建或打开失败”（`Failed to open session: <原文>`，会话行 Error；仍可以 Delete…）。检出的是分支的最新提交；
原来没提交的改动只有在归档时留着、之后又被清理掉的情况下才会没有，清理前的确认框写明了（§11.10）。

#### 11.9.5 删除

`deleteSession`（`app/src/renderer/src/state/projects.ts:250-263`）与删除确认框（`app/src/renderer/src/components/SessionEdits.tsx:85-103`）：

1. 确认框打开时，会话是 worktree 里的会话就 `worktrees.list { sessionFiles: [它] }`；确认框在原来的说明后面加一句（原文见屏幕表 fs-worktree.md）：
   拥有的 worktree 在且干净 / 有改动 / 读不出 / 正被别的开着的会话用着 / 没装 git（结果 `git: false`）各一种写法；没有拥有的 worktree、或它已经不在时不加（proposal §13 第 12 条）。
   列表返回前 Delete 不可用（`aria-disabled`）；`worktrees.list` 失败时按屏幕表“读不出”那一句显示（名字、分支取 `worktreeOf(cwd)`）并让 Delete 可用，
   点 Delete 时按有拥有的 worktree、`changes: null` 处理（`worktrees.cleanUp { paths: [worktreeOf(cwd).path], force: true }`；它自己会报 `in_use` 与 git 的错误）。
2. 点 Delete：照旧先关闭会话；有要删的 worktree（在、不是正被别的会话用着、`git` 为真）时 `worktrees.cleanUp { paths: [它], force: true }`；
   没装 git 时不删 worktree、照常删会话（临时默认值：会话总能删；worktree 留在磁盘上，确认框写明）；
   结果有 `error` 时停下，确认框显示 `Couldn’t delete this session: <原文>`，会话文件还在（会话已关闭，同现在“已关闭、删除文件失败”那一行）；
   `in_use` 时不删 worktree，照常删会话（确认框已写明）。
3. 然后照旧删会话文件、TaskBoard 目录、草稿。分支留着。

还没保存的 worktree 会话（第一条消息没能写进会话，§11.5.7）也这样删：它的 `Entry.worktree` 在关闭之前由 `worktrees.list` 取到。

### 11.10 设置页 Clean up worktrees

设置页加一节 `Storage`（照 Claude 把 Clean up 放在 Settings > Storage），排在 §9.6 的 `General` 之后（临时默认值；When you’re away 在 `General`，两节都留），
里面一块 `Worktrees`：

1. 进入这一节（你的操作）时读一次：界面把已归档列表里、`worktreeOf(cwd)` 不为 null 的会话文件交给 `worktrees.list`；列出 `exists` 的项：会话名、分支、
   `Uncommitted changes` / `No uncommitted changes` / `In use by an open session`。不轮询，清理之后再读一次。
2. `Clean up worktrees…`：没有可删的项（都不在或都在用）时不可用；点了弹确认框，写明会删掉这些 worktree 和里面没提交的改动、分支和会话都留着、不能撤销（照 Claude 的 Clean up，删之前确认）。
3. 确认后 `worktrees.cleanUp { paths: 可删的项, force: true }`；逐项失败的列在这一块里 `Couldn’t delete <branch>: <原文>`。
4. 只在你点了之后做；没有定时清理，也不按天数清理（Claude 的 30 天自动删除不做，proposal §9 第 5 条）。

### 11.11 Initialize git

**入口**：输入框下一行的 `Initialize git…`（§11.4），以及右栏 “Not a git repository” 下的同名按钮（§5、fs-changes.md）；两处打开同一个确认框（新组件 `InitGitDialog.tsx`）。
确认框写明会做的事（proposal §13 第 13 条），原文见屏幕表。确认后发 `workspace.initGit { sessionId }`。

**后台进程**（`kernel/workspace.ts` 的 `initGit(cwd)`，cwd 是这个会话的工作路径）：

1. 会话（含后台 Agent）在运行或准备中 → `This session is still running. Stop it first.`（现有原文，临时默认值：不在运行中提交写了一半的文件）；
2. §3 的 `git.state` 不是 `ok` → `Git is required to initialize a repository.`；`repoInfo(cwd)` 不为 null → `This folder is already a git repository.`；
   `repoInfo` 出错（例如 `detected dubious ownership`）→ 它的原文，不做任何事；
3. `git config --get user.name` 或 `user.email` 为空（在 cwd 里跑，读到全局和系统配置）→ 不做任何事，原因
   `Git needs your name and email for the first commit. Set user.name and user.email with git config --global, then try again.`（临时默认值：不替你用别的名字提交）；
4. `git init`（默认分支名按你的 git 配置 `init.defaultBranch`）；
5. §7.10 的 `ensureWork(cwd)`（`.work/.gitignore`；§7.10 在不是 git 仓库的文件夹里本来也写它，这里补上被删掉的情况），所以 `.work/` 不进第一次提交；
6. `git add -A`（按 `.gitignore`；超时 120 s，同 `createWorktree` 从参数传入，测试用）；
7. `git commit --allow-empty -m "Initial commit"`（空文件夹也有第一个提交，之后才能开 Worktree；超时 120 s）。

第 4 步之前记下 `<cwd>/.git` 在不在（第 2 步 `repoInfo` 为 null 时它一般不在；在的话是认不出的残骸，不动它）。第 4 步起任何一步失败或超时：结束 git 进程后，
`.git` 是本次 `git init` 建的就整个删掉（`fs.rm` 递归；里面只有 git 自己写的文件，没有你的数据；被结束的 `git add` 留下的 `index.lock` 也一起删掉），
文件夹回到 Initialize 之前，确认框里可以再试；本来就有 `.git` 时不删，只报错。`ensureWork` 建的 `.work/` 留着（无害）。原因是 git 原文；超时时为
`timed out after 120 seconds`。结果 `{ initialized: true }`，失败时命令报错，确认框显示 `Couldn’t initialize git: <原因>`。

**之后**：后台进程为这个工作路径读一次 git 状态（§3.5，成功、失败都读）：输入框下一行换成 `Worktree` 开关，右栏显示 git 状态。
§3.5 把结果发给这个工作路径上所有开着的用户会话，所以同一文件夹里别的开着的会话一起变；开在它的子文件夹里的会话是别的工作路径，在它们下次读状态时（§3.5 的时机）变过来。
内部仓库不换（每个工作路径一个，与是不是 git 仓库无关，§4）；`repoInfo` 不缓存、内部仓库的 `info/exclude` 每次拍之前重新生成（§3.4 第 6 条、§4.3），
所以从下一张快照起排除改按 git 仓库的规则。`git init` 写的 `.git/` 本来就不进快照。
Initialize git 在两次运行之间做，它和第一次提交都不算哪一轮的改动。

### 11.12 不做的

- 不做 Claude 的 Worktree location、Branch prefix 设置（proposal §13 第 8 条），不做 `.worktreeinclude`。
- 不做合并按钮、PR、同步基础分支；合并和提交由你跟 Agent 说，或用你自己的 git 工具（proposal §5.4）。
- 不做 `git worktree lock`；没有定时或按天数的清理。
- 不按实例开 worktree（平行 Agent 规格 §0 仍不在范围）。
- 不读 git 来给侧栏标分支（§11.3）。

## 12. 命令、事件与会话条目

全部经现有的进程桥：命令与条目用 zod 校验（`shared/workspace.ts` 的 `WorkspaceCommandSchemas` 并进 `shared/protocol.ts` 的 `CommandSchema`），事件并进 `KernelEvent`。
读出来的条目不合法时跳过并记日志（同 `mori.wake`）。

| 名字 | 方向 | 载荷（字段与类型） | 节 |
| --- | --- | --- | --- |
| `workspace.status` | 界面 → 后台 | `{ sessionId }` → `WorkspaceStatus`；没装 git 时也返回（`git.state: 'missing'`） | §3.5 |
| `mori.workspace_status` | 后台 → 界面（用户会话的信封） | `{ type, status: WorkspaceStatus }`；每读完一次给这个工作路径上所有打开的用户会话，快照状态变了也发 | §3.5 |
| `snapshots.diff` | 界面 → 后台 | `{ sessionId, round: string, path: string }` → `{ patch: string \| null, binary: boolean, truncated: boolean, error: string \| null }`；`round` 是轮的条目 id，`path` 相对工作路径 | §5.3 |
| `snapshots.drop` | 界面 → 后台 | `{ sessionId, cwd }` → `{ error: string \| null }`；`mori:delete-session` 成功后发，会话不必打开 | §4.7 |
| `rewind` | 界面 → 后台 | `{ sessionId, entryId, code: boolean, conversation: boolean, conflictChoice?: { action: 'overwrite' \| 'skip', token: string } }` → `RewindResult`；`code`、`conversation` 至少一个为真 | §5.6–§5.11 |
| `rewind.undo` | 界面 → 后台 | `{ sessionId, undoId: string, conflictChoice? }` → `RewindResult`；`undoId` 是 `mori.rewind` 的条目 id | §5.9 |
| `mori.turn_changes` | 后台 → 界面（用户会话的信封）；也是会话条目 | `RunRecord \| ChangesRecord`，事件与条目相同 | §4.6 |
| `mori.snapshot_stage` | 后台 → 界面（用户会话的信封；只为用户会话自己的运行发） | `{ type, active: boolean }`：运行开始的快照作业排进队列前 `true`，做完、失败、被停止或不拍时 `false`；界面按模型层等待的做法显示阶段行 `Taking a snapshot… · <秒数>` | §4.5、§13 |
| `mori.rewind` | 后台 → 界面；也是会话条目 | 事件 `{ type, entryId, record: RewindRecord }`；条目 `RewindRecord` | §5.9 |
| `mori.pick`（模型层现有的条目） | 会话条目 | 载荷不变；恢复对话、Undo 回到原来的分支之后在新的当前分支末尾再写一条 | §5.8 |
| `RepoInfo`、`WorkspaceStatus`、`SnapshotState`、`RunRecord`、`ChangesRecord`、`RewindRecord`、`RewindResult` | 类型（`shared/workspace.ts`） | 见各节 | §3.4、§3.5、§4.4、§4.6、§5.9、§5.11 |
| `start` | 主进程 → 后台进程 | 加 `snapshotsDir: string` | §4.1 |
| inline extension `mori-snapshots` | pi 扩展 | `before_agent_start`、`agent_settled`、`tool_execution_end`；用户会话与实例会话都注册，必需 | §4.5 |
| `approval.setMode` | 界面 → 后台 | `{ sessionId, mode: 'ask' \| 'full' }`；去掉 `'all'`；切到 `full` 时挂起的 scope `inside` 请求按允许结束（`by: 'full'`） | §6.7 |
| `approval.answer` | 界面 → 后台 | `{ sessionId, requestId, decision: 'allow' \| 'allowSession' \| 'allowDir' \| 'reject', reason? }`；目录由后台进程按请求的 `allowDirs` 定，界面不传；`allowSession` 只用于 scope `inside`，`allowDir` 只用于有 `allowDirs` 的请求，否则命令失败 | §6.8、§6.9 |
| `approval.forget` | 界面 → 后台 | `{ sessionId, toolName?: string, dir?: string }`；两者给且只给一个，否则命令失败（`Give either toolName or dir.`）；`dir` 不分大小写比 | §6.9 |
| `ApprovalState`（结果、`SessionInfo.approval`） | 后台 → 界面 | `{ mode: 'ask' \| 'full', allowed: string[], allowedDirs: string[] }`；`DEFAULT_APPROVAL = { mode: 'ask', allowed: [], allowedDirs: [] }` | §6.7 |
| `mori.approval_request`、`mori.team_approval_request`（`ApprovalRequestInfo`、`TeamApprovalRequest`；`LiveSnapshot.approvals`、`teamApprovals`，`SessionInfo.teamApprovals`） | 后台 → 界面 | 现有字段加 `scope: ApprovalScope`、`targets: ApprovalTarget[]`、`allowDirs: string[]` | §6.12、§6.13 |
| `ApprovalScope`、`ApprovalTarget` | 类型 | `'inside' \| 'outside' \| 'protected'`；`{ reason: 'outside' \| 'protected' \| 'unresolved' \| 'leaves' \| 'unanalyzed'; path: string \| null; text: string }`（`unanalyzed` 的 `text` 为 §7.8 的原因） | §6.13 |
| `mori.tool_gate` | 后台 → 界面 | `gate: ToolGate`（下面）；实际与预告不同就发更正 | §6.14 |
| `mori.approval_end`、`mori.team_approval_end` | 后台 → 界面 | `by: ApprovalEndBy`（下面） | §6.14、§9.4 |
| `ScanInput`、`ScanResult`、`ScanWrite`、`ScanLeave` | 后台进程内部（不过进程桥） | `ScanInput { command, shell: 'bash' \| 'powershell', cwd, vars }`；`ScanResult = { ok: true, writes: ScanWrite[], leaves: ScanLeave[] } \| { ok: false, reason }`；`ScanWrite { form, text, path: string \| null, unknown: UnknownWhy \| null, remove, into }`；`ScanLeave { form, text, dir: string \| null, command }` | §7.2 |
| `task_create.limits`、`agent_message.limits` | Agent 工具参数 | `limits?: { write?: boolean, commands?: boolean, mcp?: boolean, write_paths?: string[] }`（`write_paths` 1–10 项，只有 `false` 收窄）；代替 `task_create.read_only`（删去，原来必填）；`agent_message.limits` 只在开临时提问时用；`task_edit` 不能改 | §8.2 |
| `board.json` 的 `BoardTask.limits` | 后台进程写、读 | `limits: { write?: false, commands?: false, mcp?: false, writePaths?: string[] }`，必填，没有限制时为 `{}`；代替 `readOnly`；带 `readOnly`、没有 `limits` 的文件读不出 | §8.2、§8.8 |
| `mori.team` 条目 | 会话条目 | `{ mode }`，去掉 `tools` | §8.6 |
| `window_focus` | 主进程 → 后台进程（`parentPort`） | `{ type: 'window_focus'; focused: boolean }`；焦点变化时发，接上通道时补发一次 | §9.1 |
| `away.get`、`away.set` | 界面 → 后台 | `{}` / `{ timeout: AwayTimeout }` → `{ timeout: AwayTimeout; error: string \| null }`；`AwayTimeout = '60s' \| '5m' \| '10m' \| 'never'` | §9.6 |
| `mori.away_timer` | 后台 → 界面（用户会话的信封，后台实例的卡也是） | `{ requestId: string; deadline: number \| null }`：开始计时发截止时刻（ms），切回 Mori、计时清零时发 `null` | §9.3 |
| `mori.away_decision` | 后台 → 界面（用户会话的信封）；也是用户会话的条目 | `AwayDecision` | §9.7 |
| `mori.away_reminder` | 会话里的 `custom_message` 条目（`display: false`） | `content`：提醒原文；进模型上下文，界面不显示 | §9.8 |
| `mori-approval` 的 `agent_before_settle` | pi 扩展的处理器 | 返回 `{ entries: [...event.entries, 提醒], continue: true }` 或 `undefined` | §9.8 |
| `LiveSnapshot.awayTimers` | `session.open` 结果 | `{ requestId: string; deadline: number }[]` | §9.5 |
| `ask_user_question` | Agent 工具（扩展 `mori-question`，只在用户会话） | `{ questions: AskQuestion[] }`；结果 `details: { answers: AskAnswer[] \| null, by }` | §10.1、§10.2 |
| `mori.question_request` | 后台 → 界面（用户会话的信封） | `{ requestId: string; toolCallId: string; questions: AskQuestion[]; askedAt: number }` | §10.3 |
| `mori.question_end` | 后台 → 界面（用户会话的信封） | `{ requestId: string; toolCallId: string; by: 'user' \| 'declined' \| 'away' \| 'stop' \| 'closed'; answers: AskAnswer[] \| null }` | §10.3 |
| `question.answer` | 界面 → 后台 | `{ sessionId, requestId, answers: { selected: string[]; other: string \| null }[] \| null }` → `null`；`null` 为拒绝回答，不合格或已结束时命令失败 | §10.5 |
| `LiveSnapshot.asks`、`LiveStatus.question` | `session.open`、`session.list` 结果 | `mori.question_request` 的载荷数组，按提出的顺序；有挂起的扩展询问**或提问卡**时 `question` 为真 | §10 |
| `task_handoff.options`、`task_handoff.recommended` | Agent 工具参数（task 实例、结案会话） | `options?: string[]`（2–4 项，每项 ≤ 60 字符）、`recommended?: string`；只配 `need_user`；`board.json` 的 `Handoff` 加 `options?: string[]`、`recommended?: string \| null` | §10.8 |
| `session.prompt` | 界面 → 后台 | 现有字段加 `worktree?: boolean`（只对第一条消息有效）；结果 `{ accepted: true; held: boolean; session?: SessionInfo }`，带了 `worktree: true` 时总有 `session` | §11.5 |
| `SessionInfo.worktree` | 命令结果 | `{ path: string; branch: string; mainFolder: string } \| null` | §11.6 |
| `mori.worktree` | 会话条目（不进模型上下文） | `{ path: string /* worktree 根 */; branch: string; mainFolder: string }`；§11.5.4 写一次，表示拥有 | §11.6 |
| `mori.prompt_error` | 后台 → 界面（载荷不变） | 建 worktree 失败时 `message: 'Couldn’t create the worktree: <原因>'`，`text`、`refs` 为这条消息 | §11.5.7 |
| `workspace.initGit` | 界面 → 后台 | `{ sessionId: string }` → `{ initialized: true }`；失败时命令报错 | §11.11 |
| `worktrees.list` | 界面 → 后台 | `{ sessionFiles: string[] }` → `{ git: boolean; items: { sessionFile: string; path: string; branch: string; mainFolder: string; exists: boolean; changes: boolean \| null; inUse: boolean }[] }` | §11.9.1 |
| `worktrees.cleanUp` | 界面 → 后台 | `{ paths: string[]; force: boolean }` → `{ results: { path: string; removed: boolean; reason: 'changes' \| 'in_use' \| 'missing' \| null; error: string \| null }[] }`；只删 Mori worktree，分支从不删 | §11.9.1 |
| `mori.memory_changed` | 后台 → 界面（载荷字段不变） | `cwd` 改为 `projectFolder(写入时的 cwd)` | §11.7 |
| `worktreeOf(cwd)`、`projectFolder(cwd)`、`refsInto(refs, from, to)` | `shared/workspace.ts` 的纯函数 | 界面与后台进程共用 | §11.3、§11.5.5 |
| 操作记录（`state/actionLog.ts`，F8 的 Recent activity） | 界面 | `Refresh changes`、`Rewind: <菜单项>`、`Rewind conflicts: Overwrite` / `Skip these files` / `Cancel`、`Undo rewind`；`Permission mode: Full access`、`Permission request: Allow writes to folders for this session`、`Forget “Allow for this session”: writes to <目录>`；`Turn on worktree`、`Turn off worktree`、`Initialize git`、`Clean up worktrees` | §5、§6.14、§11 |

**最终取值**（以 §6.14 为底，加 §9 的 `'away'`）：

- `ToolGate = 'ask' | 'session' | 'dir' | 'full' | 'free' | 'deny'`（去掉 `'all'`）：`session` 按工具名放行，`dir` 按目录放行，`full` Full access 放行，
  `free` 读取、按职责给的工具（含 `ask_user_question`）与写 `.work`，`deny` 不出卡就拒绝（收窄，或没人能批）。
- `ApprovalEndBy = 'user' | 'session' | 'dir' | 'full' | 'stop' | 'closed' | 'away'`（去掉 `'all'`；`away` 是 §9.4 的到时拒绝）。

**`DENIAL_PREFIXES`**（`shared/workspace.ts`，界面不能 import `kernel/`，所以放在 shared）：程序拒绝原文的固定开头。`parseRejection`（`app/src/renderer/src/state/model.ts:292-297`）
在你拒绝、停止的三种原文之后按这张表认，以其中之一开头时返回表里的理由，工具卡显示 `Denied · <理由>`（40 字截断，悬停看全文）；
重新打开时只对 `isError` 的结果认（`app/src/renderer/src/state/history.ts:68`），实时按 §6.15、§9.4、§10.6。

| 开头（或整句） | 出处 | 工具卡 |
| --- | --- | --- |
| `Denied by Mori: ` | §6.15，没人能批 | `Denied · <原文>` |
| `Not allowed for this task: `、`Not allowed for this question: `、`Not allowed while deciding requests: `、`Not allowed while closing a request: `、`Not allowed in a subscription: `（`NARROWING_LEADS` 的五个开头各接 `: `） | §8.3、§8.4，收窄 | `Denied · <原文>` |
| `RELAY_ONLY` 整句：`Task mode is on: the dialog agent only relays; the work is done in tasks.` | §8.3，协作模式下的对话会话与合并会话 | `Denied · <原文>` |
| `REJECTED_AWAY_PREFIX`：`The user was away and didn’t answer within ` | §9.4，你不在、批准卡到时 | `Denied · No answer while you were away` |
| `Mori couldn’t prepare .work in the working directory` | §7.10，`ensureWork` 失败、放行的调用被挡下 | `Denied · <原文>`，没有放行标签 |
| `ASK_DECLINED_TEXT` 整句：`The user declined to answer your questions. Stop what you are doing and wait for the user to tell you how to proceed.` | §10.6，你拒绝回答提问 | `Denied · You declined to answer` |
| `ASK_STOPPED_TEXT` 整句：`Not answered: the user stopped the run.` | §10.6，提问时你按了停止、会话关闭 | `Stopped`：不算拒绝，`addToolResult` 与 `ABORTED_TOOL` 一样算已停止 |
| mori-team、mori-memory 先于路径闸的拒绝：开头 `You handed off `；整句 `Only task_handoff works in this turn; call it now.`、`Only request_close works in this turn; call it now.`、`Memory files can only be changed with the memory tool or on the Memory page.`、`Enhancement runs can only change memory, with the memory tool.` | 平行 Agent 规格 §7.1、§7.5（交接后、强制填写），记忆规格 §7.7、§9.6 | `Denied · <原文>`，预告时标上的放行标签去掉（2026-10-27 注：负责人定） |

提问卡到时的工具结果（§14）与 `REJECTED_AWAY_PREFIX` 开头相同，但它不是 `isError`，实时也只从 `mori.approval_end` 认批准卡的到时，两者不会混（§9.4）。

## 13. 界面

屏幕状态表（新文件，在 `docs/v1/screens/`，格式照同目录的 team-approvals.md、models-settings.md：状态 ｜ 来源 ｜ 必须可见 ｜ 可做的操作；“来源”只能是事件、命令结果、
会话条目或你刚做的操作）。界面文字为英文，写法按 [v0/ui-strings.md](../v0/ui-strings.md)，有 Claude 对应的照 Claude 的用词；标“（临时，走查时可以改）”的是规格没给、状态表定的。

| 状态表 | 内容 |
| --- | --- |
| [fs-permissions.md](../v1/screens/fs-permissions.md) | 输入框下一行的权限按钮与菜单（Ask each time / Full access、Allowed for this session 的工具名与 `Writes to <目录>`、各自的 Forget）、切到 Full access 的确认、批准卡的原因行与第二个选项、工具卡的标签与 `Denied · …`、F8 报告与操作记录（§6、§7.8） |
| [fs-changes.md](../v1/screens/fs-changes.md) | 顶栏 `+N −M`；右栏 Changes 的外框与三种文件夹（git 仓库、Not a git repository、Git is required）；git 状态；This session（按轮、文件行、点开的 diff、各种说明行、嵌套仓库那一行）；阅读器的重读；Refresh（§3.5、§4.4、§4.6、§5.1–§5.4） |
| [fs-rewind.md](../v1/screens/fs-rewind.md) | 消息上的 `Rewind`、菜单的四种情况与 `No code restore`、进行中、冲突列表、完成的通知与 Undo、不能 Rewind 的原因、重新载入与重启（§5.5–§5.11） |
| [fs-question.md](../v1/screens/fs-question.md) | 提问卡；批准卡、提问卡与扩展询问卡在你不在时的倒计时；一轮末尾的 Decided while you were away；工具卡、阶段行、侧栏、任务栏；设置页 `General` 的 When you’re away（§9、§10） |
| [fs-worktree.md](../v1/screens/fs-worktree.md) | 输入框下一行的 `Worktree` 开关与 `Initialize git…`、建 worktree 中与失败、Initialize git 确认框、侧栏分组与分支标签、归档/恢复/删除、打开 worktree 不在的会话、设置页 `Storage` 的 Worktrees（§11） |

**输入框下一行**（左起）：

1. 权限按钮 `Ask each time ▾` / `Full access ▾`（Full access 用警示色，读屏名 `Permission mode: Full access`）；切到 Full access 先确认（§6.7、§6.13）。
2. 新会话还没发消息时紧跟着：已有提交的 git 仓库是 `Worktree` 开关（默认关），不是 git 仓库是 `Initialize git…`；还没有提交的仓库、`repoInfo` 出错、没装 git 或版本太低时两样都不显示（§11.4）。
   它和权限按钮一起靠左，原来推开右边一组的 `margin-left: auto` 移到它后面那一项；这一栏 ≤ 460px 时只剩图标 `branch`。
3. 其余各项（范围、Effort 等）不变。

**其他位置**：顶栏 `Toggle changes` 左边的 `+N −M`（§5.4）；右栏 Changes（§5.1）；你的消息上的 `Rewind`（§5.5）；批准卡的原因行与倒计时（§6.13、§9.9）；
提问卡（§10.4）；一轮末尾的 Decided while you were away（§9.9）；侧栏 worktree 会话的分支标签（§11.7）；
阶段行在运行开始的快照期间（`agent_start` 之前）显示 `Taking a snapshot… · <秒数>`（§4.5，fs-changes.md）：`mori.snapshot_stage` 照 `applyModelWait` 的做法交给
`startModelStage(state, 'snapshot', 'Taking a snapshot…', now)` / `endModelStage(state, 'snapshot')`（`app/src/renderer/src/state/transcript.ts:388-396`；
`ModelStage.kind` 加 `'snapshot'`，`app/src/renderer/src/state/model.ts:171`）。`StageLine.tsx:17-21` 的 `modelStageShown` 已经要求 `running || sending` 且没有批准卡、询问，
`applySettled`、`dropPending` 已经清掉它，`agent_start` 另外清掉 kind `snapshot`；阶段行 `data-kind="snapshot"`。
[model-chat.md](../v1/screens/model-chat.md)“准备中”一节加注：这段等待显示（§18）。

**设置页**：左边的分节在 Models、AGENTS.md、UI issues 之后加两节：

- `General`（新）：一行 When you’re away，60 seconds / 5 minutes（默认）/ 10 minutes / Never（§9.6）；
- `Storage`（新，照 Claude 的 Settings > Storage，排在 `General` 之后）：一块 `Worktrees`，列出已归档会话留下的 worktree 与 `Clean up worktrees…`（§11.10）。

## 14. 模型看到的文字

身份段（`identityText(permission)`，记忆规格附录 A.1）四行：第一、第四行不变；第二行按这次运行开始时的模式三选一（§6.16）；第三行（`.work`，§7.12）三种都一样，
对所有会话与实例相同（2026-10-27 注：负责人定：加上 `.work` 一行后 Ask each time 的身份段为 523 token，超过记忆规格 MEM-01 原来的 500 token；
`.work` 一行与权限句照下面原文不缩，MEM-01 的上限改为 2000 token）。2026-10-27 注：合并 subagent 那条线后，第四行原来的最后一句“Tasks you create and questions you send …”拿出去，改为按这次运行启用的交出去的工具拼、接在第四行末尾（记忆规格附录 A.1.1）；原文里 team mode 的写法随 Task mode 改名（2026-10-27 注：Task mode 改名，见 docs/v1/walkthrough-1026-checks.md U53）；工具卡、Customize 里看得到的原文撇号用 ’（2026-10-27 注：工具卡、Customize 里看得到，撇号用 ’，见 docs/v1/walkthrough-1026-checks.md U60）。Ask each time 时的全文：

```text
You are Mori, a coding assistant working in the user's project folder. You read files, run commands, edit code and write files to get the user's work done.
Tool calls other than reading and searching may wait for the user's approval. A denied call returns the user's reason as its result: follow it and don't repeat the call.
Put scripts, drafts, and temporary files you need along the way in .work/ in the working directory. Git ignores it, and edit and write calls there never wait for the user's approval. Commands run with TEMP, TMP, and TMPDIR set to .work/tmp; use them instead of /tmp.
The sections after the project information hold what Mori has learned with this user: <taste> how to talk with the user, <strategy> how to size and plan work, <review> what to check before saying work is done, <facts> what is true about the user and this project. Follow them unless the user says otherwise.
```

| 用途 | 原文（英文） | 何时发给模型 |
| --- | --- | --- |
| 身份段第二行，Ask each time | `Tool calls other than reading and searching may wait for the user's approval. A denied call returns the user's reason as its result: follow it and don't repeat the call.`（与现在相同） | 运行开始时模式为 `ask` |
| 身份段第二行，Full access | `Reading, searching and MCP tools run without approval, and so do edits, writes and commands inside the working directory. Writes outside the working directory or to protected paths (.git, .mori, .pi and similar), and commands that change to a directory outside it, wait for the user's approval. A denied call returns the user's reason as its result: follow it and don't repeat the call.` | 运行开始时模式为 `full` 且有人能批 |
| 身份段第二行，没人能批 | `Nobody can approve tool calls in this run: writes outside the working directory or to protected paths (.git, .mori, .pi and similar), and commands that change to a directory outside it, are denied, so don't try them.` | 增强会话与它的实例（`canAsk` 为假） |
| 身份段第三行（`.work`） | `Put scripts, drafts, and temporary files you need along the way in .work/ in the working directory. Git ignores it, and edit and write calls there never wait for the user's approval. Commands run with TEMP, TMP, and TMPDIR set to .work/tmp; use them instead of /tmp.` | 每次运行（所有会话与实例） |
| 没人能批时的拒绝 | `Denied by Mori: nobody can approve tool calls in this run, and this call <why>. Don't retry it.`；`<why>` 按目标的理由拼，几种之间用 `; `，每种最多列 5 个（多的 `and <n> more`）：`writes outside the working directory: <path>, <path>` / `writes to a protected path: <path>` / `writes to a path Mori can't resolve: <text>` / `runs outside the working directory: <path 或 text>` / `can't be analyzed: <reason>` / scope `inside` 时 `needs the user's approval` | `canAsk` 为假的会话里该出卡的调用（工具结果），含增强会话里写到外面或受保护路径的命令 |
| 你拒绝、停止 | `Rejected by the user.` / `Rejected by the user. Reason: <理由>` / `Rejected: the user stopped the run.`（不变） | 同现在 |
| 命令分析不了的原因 | `unclosed quote`、`unclosed bracket`、`unclosed command substitution`、`the command name comes from a variable or substitution`、`the command text comes from a variable or input`、`encoded command`、`unsupported option <选项>`、`PowerShell has no < redirection`、`nested too deeply`、`the command is too long` | 接在 `can't be analyzed: ` 后面（没人能批时）；批准卡上为 `Couldn’t analyze this command: <reason>` |
| `.work` 建不起来 | `Mori couldn’t prepare .work in the working directory (<reason>), so this call didn’t run. Tell the user.`；`<reason>` 为 `.work is a file, not a folder`、`.work/tmp is a file, not a folder` 或 Node 的错误原文 | 放行的 bash / powershell 调用、写进 `.work` 的 write / edit，`ensureWork` 失败时（工具结果） |
| `task_create` 的说明 | `Create a task of a request for one role: title, what to do, assignee, limits (optional: what the agents on it may not do) and depends_on (tasks of the same request that must be done first).` | 立项持有者的会话的工具定义 |
| `task_create.limits` 的说明 | `What every agent on this task may not do; leave it out for no limits. write: false means no file changes and no commands, for a task that only reads or reviews (such tasks run alongside others). commands: false means no commands. mcp: false means no MCP or extension tools. write_paths limits file changes to some folders; .work/ stays writable.`（2026-10-28 注：负责人定只读会话可以跑只读命令，file-system-permissions.md §8.11；`no file changes and no commands` 改为 `no file changes and only read-only commands`） | 同上 |
| `limits` 子项的说明（`agent_message.limits` 用同一组） | `write`：`false: no file changes and no commands.`（2026-10-28 注：负责人定只读会话可以跑只读命令，file-system-permissions.md §8.11；改为 `false: no file changes; only read-only commands.`） / `commands`：`false: no commands.` / `mcp`：`false: no MCP or extension tools.` / `write_paths`：`Folders relative to the working directory, e.g. ["src/"]; file changes outside them (except .work/) are refused.` | 同上 |
| `task_create` 的 Correct form | `task_create {"request":1,"title":"<one line>","description":"<what to do>","assignee":"<role>"}; add "limits":{"write":false} when the task must not change files or run commands`（2026-10-28 注：负责人定只读会话可以跑只读命令，file-system-permissions.md §8.11；句末改为 `when the task must not change files`） | `task_create` 出错时的第二行 |
| `agent_message.limits` 的说明 | `Only for a question to a role that opens a one-time question: it never changes files or runs commands and keeps your own limits; mcp: false also keeps it from MCP and extension tools.`（2026-10-28 注：负责人定只读会话可以跑只读命令，file-system-permissions.md §8.11；`it never changes files or runs commands` 改为 `it never changes files, runs only read-only commands`） | 有 `agent_message` 的会话 |
| 不变的 | `agent_message` 的两段说明（`ASK_DESCRIPTION`、`TEAM_MESSAGE_DESCRIPTION`）、关闭模式的对话段（第一行是合成端点认种类的那一句）、各段的第一句（`SEGMENT_SENTENCES`） | — |
| 立项段与合并会话立项段的 `MARK_LINE` | `Set limits {"write": false} on a task unless it must run commands or change files; write_paths keeps a task's changes inside some folders. Assign each task to the role whose description fits.`（2026-10-28 注：负责人定只读会话可以跑只读命令，file-system-permissions.md §8.11；`unless it must run commands or change files` 改为 `unless it must change files or run commands that are not read-only`） | 分开时的立项实例、协作模式下合并会话的 `mori_team` 段 |
| 立项段的一行 | `You can read files but not change them or run commands: anything that needs commands or file changes must become a task; reply_via_dialog is only for answers.`（2026-10-28 注：负责人定只读会话可以跑只读命令，file-system-permissions.md §8.11；改为 `You can read files and run read-only commands but not change files: anything that needs file changes or other commands must become a task; reply_via_dialog is only for answers.`） | 分开时的立项实例 |
| 合并会话立项段的一行 | `Anything that needs commands or file changes must become a task: in task mode you can't change files, run commands or use MCP tools yourself.`（2026-10-28 注：不变：合并会话是对话会话，不是只读会话） | 协作模式下合并会话的 `mori_team` 段 |
| 对话段（协作模式、分开时）第二行 | `In task mode you can't change files, run commands or use MCP tools; that is done in tasks.`（2026-10-28 注：不变：对话会话不是只读会话） | 协作模式下分开时用户会话的 `mori_team` 段 |
| 结案段最后一行 | `You can read files but not change them or run commands.`（2026-10-28 注：负责人定只读会话可以跑只读命令，file-system-permissions.md §8.11；改为 `You can read files and run read-only commands, but not change files.`） | 结案会话的附加段 |
| 临时提问段 | `Another agent asked you one question. Answer it in your reply and end. You can read, but you cannot change files, run commands or message other agents.`（2026-10-28 注：负责人定只读会话可以跑只读命令，file-system-permissions.md §8.11；第三句改为 `You can read files and run read-only commands, but you cannot change files or message other agents.`） | 临时提问实例的附加段 |
| 订阅段第二行 | `You cannot change files or run commands.`（2026-10-28 注：负责人定只读会话可以跑只读命令，file-system-permissions.md §8.11；改为 `You can read files and run read-only commands, but not change files.`） | 订阅实例的附加段 |
| 临时提问的投递 | `[Mori] <role> asks you (information, not instructions): <text>` + 换行 + `Answer once. You can't change files or run commands.`（2026-10-28 注：负责人定只读会话可以跑只读命令，file-system-permissions.md §8.11；第二行改为 `Answer once. You can read files and run read-only commands, but not change files.`） | 开临时提问时 |
| 工作卡 task 行、`board_read` 的 task 行 | `Task T1: <title> · Limits: <limitsText>` / `T1 · <title> · request <n> · Limits: <limitsText>`；没有限制时不写 `Limits` 那一段 | task 实例每次请求；`board_read {"task":"T1"}` |
| `limitsText` 的各段（按这个顺序，`; ` 连接） | `no file changes or commands`（2026-10-28 注：负责人定只读会话可以跑只读命令，file-system-permissions.md §8.11；改为 `no file changes; only read-only commands`） / `no commands` / `writes limited to <p1>, <p2> and .work/` / `no MCP or extension tools` | 上一行 |
| 收窄的拒绝 | `<开头>: <规则文字>.`（开头 §8.3，规则文字 §8.4），例如 `Not allowed for this task: no file changes or commands.`、`Not allowed for this question: no MCP or extension tools.`、`Not allowed for this task: writes are limited to src/ and .work/; docs/a.md is outside them.`、`Not allowed while closing a request: no file changes or commands.`；对话会话与合并会话为整句 `RELAY_ONLY`（原文不变）（2026-10-28 注：负责人定只读会话可以跑只读命令，file-system-permissions.md §8.11；只读会话里不是只读命令的命令为 `<开头>: only read-only commands.`，例如 `Not allowed for this task: only read-only commands.`；只读会话没有 `edit`、`write`，`no file changes or commands` 只留给工具名是 `edit`、`write` 的调用） | 越界的调用（工具结果） |
| `limits` 校验的原因（第二行是这个工具的 Correct form） | `limits.write_paths: "<p>" must be relative to the working directory.` / `limits.write_paths: "<p>" is outside the working directory.` / `limits.write_paths: "<p>" is the whole working directory; leave write_paths out.` | `task_create`、`agent_message` 的 `limits` 不合格 |
| 自动拒绝 | `The user was away and didn’t answer within 5 minutes, so this was denied. Don’t retry it. Mention it in your final summary.`；task 实例、结案会话（`GateOutput.kind` 为 `task`、`close`）最后一句为 `Mention it in your handoff.`；时长按当时的设置写 `60 seconds` / `5 minutes` / `10 minutes` | 批准卡到时，作为这次调用的工具结果 |
| 提醒 | `[Mori] The user was away, so Mori decided these without them during this turn:`，每项一行（`- Denied bash: npm publish`、`- Used your recommended option for "Which database should I use?": PostgreSQL`），最后 `Don't retry the denied calls. Mention all of these in your final summary.`（task 实例、结案会话为 `… in your handoff.`，按 `AwayItem.kind`，§9.8） | `agent_before_settle`，一次运行一次（§9.8） |
| `ask_user_question` 的说明 | `Ask the user 1-4 questions, each with 2-4 options, and wait for the answers. Use it when you need the user’s decision or preference to go on: a choice between approaches, a missing requirement, or which of several things they meant. Don’t use it for what you can find out yourself, or to ask permission to run a tool. The user can always type their own answer instead of picking an option, so don’t add an "Other" option. Set recommended to the label of the option you would pick; if the user is away and doesn’t answer in time, Mori uses it and tells you.` | 用户会话每次请求的 `tools` 参数 |
| `ask_user_question` 的参数说明 | `questions`：`The questions, 1-4, shown together on one card in this order.` / `question`：`The full question, ending with a question mark.` / `header`：`A short tag for the question, at most 12 characters, e.g. Database.` / `options`：`2-4 options.` / `label`：`What the user picks, in a few words.` / `description`：`What this option means, or what happens if the user picks it.` / `multiSelect`：`true if the user may pick more than one option.` / `recommended`：`The label of the option you recommend; it must be one of the labels.` | 同上 |
| 结果：你提交 / 你不在 | `User has answered your questions: "Which database should I use?"="PostgreSQL", "Which parts?"="API, CLI". You can now continue with the user’s answers in mind.` / `The user was away and didn’t answer within 5 minutes, so your recommended options were used: "Which database should I use?"="PostgreSQL". Continue with them, and mention this in your final summary.` | 你在卡上提交 / 提问卡到时（时长按设置） |
| 结果：拒绝回答 / 停止、关闭 | `ASK_DECLINED_TEXT` / `ASK_STOPPED_TEXT`（原文见 §12） | Esc / 停止、`Stop team`、会话关闭 |
| 提问的校验错误（`isError: true`，第二行为 Correct form） | `Question 2: recommended "MySQL" is not one of its option labels: PostgreSQL, SQLite.` / `Question 1: option labels must be different.` / `Question 1: don’t add an "Other" option; the user can always type their own answer.` / `Each question must be different.` / `Question 1: question must be 1-500 characters.` / `Question 1: header must be 1-12 characters.` / `Question 1: option label must be 1-60 characters.` / `Question 1: option description must be at most 300 characters.` | 执行时校验不过 |
| 提问错误的第二行 | `Correct form: ask_user_question {"questions":[{"question":"Which database should I use?","header":"Database","options":[{"label":"PostgreSQL","description":"Server database"},{"label":"SQLite","description":"Single file"}],"multiSelect":false,"recommended":"PostgreSQL"}]}` | 同上 |
| 转给立项（分开时） | `[Mori] New user message: Answer to the dialog agent's question (ask_user_question): "Which database should I use?"="PostgreSQL"` + 换行 + `Make exactly one decision for it.`；你不在时答案后加 ` (not the user's choice: they were away, so the recommended option was used)`，多个问题用 `; ` 连接 | §10.7，立项会话的投递 |
| 交接参数说明 | `options`：`With need_user: 2-4 short choices for the user, at most 60 characters each.` / `recommended`：`With need_user and options: the choice you recommend; one of options.` | task 实例、结案会话的 `task_handoff` schema |
| 交接错误 | `options and recommended are only for need_user.` / `Give options and recommended together.` / `options must have 2-4 different items of 1-60 characters.` / `recommended must be one of options.` | `task_handoff` 校验不过 |
| `ask_user` 投递（有选项） | `[Mori] T1 needs a decision from the user: Which database should I use? Options from executor: PostgreSQL; SQLite. Recommended: PostgreSQL. Ask the user with ask_user_question, using these options and this recommendation.` | 程序请对话问你（§10.8） |
| `relay` 投递加的行 | `For T1: options from executor: PostgreSQL; SQLite. Recommended: PostgreSQL. Ask the user with ask_user_question, using these options and this recommendation.` | 立项 `reply_via_dialog` 转告、其中有带选项的 task |
| `create_need_user` 加的行 | `Options from executor: PostgreSQL; SQLite. Recommended: PostgreSQL.`；合并会话第二行结尾为 `otherwise ask the user with ask_user_question, using these options and this recommendation.` | 唤醒立项 |
| 会话引用里的工具卡标题 | `[Tool] Ask · Database, Scope` | 含提问的会话作为引用附给模型时 |
| 只读 subagent 段的第三行（2026-10-28 注：负责人定只读会话可以跑只读命令，file-system-permissions.md §8.11） | `You can read files and run read-only commands, but not change files.`（原为 `You can read files but not change them or run commands.`，subagent 规格 §6.1） | `read_only: true` 的 subagent 的附加段 |

§3–§5 与 §11 不加、不改发给模型的文字：恢复对话后模型看到的上下文就是 pi `navigateTree` 之后的当前分支（pi 的行为）；worktree 会话里 pi 的 system prompt 照旧有 `<cwd>` 一节
（`app/node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js:110`），值换成 worktree 路径；第一条消息的引用块文字换前换后相同（§11.5.5）。

**要重录的 fixture**（AGENTS.md 工作约定第 2 条：发给模型的文字、工具、批准、会话的事件都变了；载荷变了的录制重录，不给它们补默认值；
回放桥只为会话信息里界面新加的字段补 synthetic 的空值，同 `teamInfo`，§19.4）：

- `tests/fixtures/mem/mem-enhance.json`、`mem-feedback.json`、`mem-notice.json`、`mem-tool.json`：身份段变了（`.work` 一行；`mem-enhance.json` 的第二行换成没人能批那一句）；
- `tests/fixtures/tb/tb-approval.json`、`tb-ask.json`、`tb-receipts.json`、`tb-team.json`：`task_create`、`agent_message`、`task_handoff` 的 schema，实例与协作模式对话的工具列表，
  附录 A 的段与工作卡，用户会话多了 `ask_user_question`，`mori.team_approval_request` 的新字段与 `gate`、`by` 的取值；用 `tb-record.mjs` 用真实模型重录；
- `tests/fixtures/m2/*.json` 里带 `mori.approval_request` 的（载荷多了 `scope` 等）；`all-mode.json`、`pending-to-all.json` 改录为 `full-mode.json`、`pending-to-full.json`；
- `tests/fixtures/m3/ext-ui.json`、`trust-allow.json`、`trust-remembered.json`，`m4/edit-two.json`、`quote-changed.json`、`write-delete.json`，
  `m5/split-approvals.json`、`split-esc.json`，`m6/mcp.json`、`plugin.json`、`slash.json`：都带 `mori.approval_request`，分别用 `m3-record.mjs`、
  `m4-record.mjs`、`m5-record.mjs`、`m6-record.mjs` 重录；`m1-record.mjs:101` 的 `mode: 'all'` 改为 `'full'`；
- 新录 `tests/fixtures/filesystem/*.json`（§19.1）。

改了模型看到的文字，所以按 AGENTS.md 要用真实模型走一遍：FS-114（§19.2）。

## 15. 安全与资源

- **从不改 `process.env`**：git 的环境是副本（去掉 `GIT_*`，加 `LC_ALL=C`、`GIT_TERMINAL_PROMPT=0`，§3.3）；命令的 TEMP、TMP、TMPDIR 在 `spawnHook` 的副本里改（§7.11）。
  否则 pi 的 bash、PowerShell 工具和 MCP 服务都会继承这些变量（proposal §3）。
- **git 调用**：不经 shell、参数原样传；用户仓库用 `--no-optional-locks`，不和你的 git 抢锁；每次调用有超时与输出上限，超时或超过上限时结束进程并记日志；同一个仓库排队（§3.3、§17）。
- **内部仓库在工作路径外**：`%LOCALAPPDATA%\Mori\snapshots`（不进漫游配置，不在 OneDrive 里）；工作路径里不出现新的 `.git`，你的仓库不多 ref、index 不变；
  内部仓库用隔离的全局配置、不读系统配置（你的 `commit.gpgSign`、`core.autocrlf`、LFS 过滤器不作用），`info/attributes` 按字节存与恢复（§4.1）。
- **恢复只动这个会话记下的文件**：不用 `git clean`；动之前问清冲突，先拍保险快照，所以 Rewind 本身可以 Undo（§5.6、§5.7）。
- **不监视、不轮询**：`kernel/git.ts`、`workspace.ts`、`snapshots.ts` 里没有 `fs.watch`、`watchFile`、`setInterval`；git 状态只在 §3.5 的时机读，工具执行完的读去抖 500 毫秒、
  同一时刻一个；快照只在运行前后拍，同一个工作路径同一时刻一个作业；worktree 与快照的清理只在你操作时做（§3.5、§4.5、§11.9）。
- **计时有上限**：每张挂起的卡一个 `setTimeout`；每个 pi 会话的工具调用按顺序执行，所以一个会话同一时刻至多一张批准卡或提问卡（§9.3）。
- **快照的上限**：单个未跟踪文件 10 MB、一次加入 20000 个文件（多于 2000 个时每 2000 条一个 git 进程，大文件的 `stat` 是异步的）、每个 git 进程 120 秒；记录里的文件 500 个；diff 1 MB；冲突与恢复的列表各 200 条；git 状态 500 条（§17）。
- **路径闸碰文件系统的上限**：词法上在工作路径外的目标不碰文件系统，所以 `\\主机\共享\…` 这类网络路径不会让 Windows 去连那台主机、送出凭据（只有工作路径本身在网络上时才会碰网络）；
  一个目标最多“段数”次 `lstat` 和一次 `realpath`，一个调用最多解析 100 个写入目标；现算、不缓存（§6.3）。
- **命令分析是纯函数**：不读文件、不读环境变量；命令文字最多 1,000,000 个字符、嵌套 32 层，1 MB 一次不超过 500 ms（2026-10-27 注：负责人定，原为 200 ms）；解析失败的日志不写命令原文（§7.8）。
- **收窄检查是纯函数**：最多比 10 项 `writePaths` × 命令的写入目标，不读文件、不缓存（§8.4）。
- **这不是沙箱**：脚本和程序自己打开文件写到别处、MCP 与扩展工具在 Full access 下写的，Mori 看不到；切到 Full access 的确认框明说（§6.13、§7.5）。
- **`.work`**：只在放行命令或写进 `.work` 之前建，不递归 `mkdir`（不把删掉的 worktree 重新建出来）；你改过的 `.work/.gitignore` 不覆盖（§7.10）。
- **worktree**：git 步骤各有 120 秒超时，失败时按顺序撤掉建了一半的 worktree 与分支；`worktrees.cleanUp` 只删 `git worktree list` 里的 Mori worktree，分支从不删；
  没打开的会话文件按行读、读到第一条消息就停（§11.5.3、§11.6、§11.9.1）。
- **Initialize git**：运行中拒绝；先查 `user.name`、`user.email`，不替你用别的名字提交（§11.11）。
- **记录不存整份内容**：`mori.away_decision` 的参数字符串截到 300 字符，去掉 `content`、`edits`（§9.7）；`mori.turn_changes` 只记路径与行数（§4.6）。
- **有序退出**：等快照队列做完，仍受主进程 3 秒的上限（§4.5）。
- 文件阅读器解析路径、不打开网络路径的规则（`app/src/main/files.ts:21-32`、`:56-61`）不变。

## 16. 不改的

- pi：不改；只用 pi 已有的入口：`tool_call`、`before_agent_start` / `agent_settled`、`tool_execution_end`、`agent_before_settle`、bash / PowerShell 工具的 `spawnHook`（经 `customTools`）、`navigateTree`。
- `session.create`；读取在任何模式、任何路径都不问（proposal §5.1）。
- `mori-team`、`mori-memory` 在 `tool_call` 里的拒绝（交接后拒绝、强制填写；记忆目录写保护、增强会话里的 `write`、`edit`），`guardToolCall`，TaskBoard 工具按席位注册（§6.1、§8.6）。
- 你拒绝、你按了停止的三种原文；Ask each time 的身份句（§6.15、§6.16）。
- `agent_message` 的两段说明、关闭模式的对话段、各段的第一句与合成端点认种类的规则（§8.9）。
- 写入锁仍只约束这个用户会话里 Mori 派出的 Agent，不是文件系统锁（§8.7）。
- 记忆规格附录 A.3 与附录 B（§8.10）；记住信任（`app/src/kernel/trust.ts:45-56` 的 `remember`）；`projectDirName`、`normalizeProjectPath` 的编码（§11.7）。
- pi 读 `.pi/`、AGENTS.md、项目级 MCP 服务的规则（§11.8）。
- 文件阅读器、`← Changes`、`Reload file`、`Open in default app`（v0 changes.md），只改重读的依据（§5.1）；`Diff.tsx` 照用（§5.3）。
- 归档不弹确认（方案 5.3）；窗口回到前台时停止任务栏闪烁；扩展自己的超时（§9.1、§10.9）。
- “多个实例同时写工作区”仍不在范围：worktree 按会话，不按实例（平行 Agent 规格 §0）。

## 17. 临时默认值

proposal 没定、实现又必须有一个值的地方。登记在 [v1/defaults.md](../v1/defaults.md) 新一节“文件系统”；按节分组，每一行在对应节的正文里写了用在哪里。
§0“写规格时定的”八条是负责人定的，不在这里。

| 项 | 值 | 位置 | 理由 |
| --- | --- | --- | --- |
| **§3–§5 git、快照与 Rewind** | | | |
| git 最低版本 | 2.32 | `kernel/git.ts` | `GIT_CONFIG_GLOBAL` 从 2.32 起（Git for Windows RelNotes 2.32.0），内部仓库的隔离靠它（§3.3、§4.1）；`rev-parse --path-format=absolute`（2.31）、`restore`（2.23）、`--pathspec-from-file`（2.26）都更早；本机 2.55 |
| 找 git 的位置 | `PATH` 里每个目录下的 `git.exe`，然后 `C:\Program Files\Git\cmd\git.exe` | `kernel/git.ts` | Mori 不自带 git；Git for Windows 默认装在这里，pi 找 Git Bash 也看 Program Files（`app/node_modules/@earendil-works/pi-coding-agent/dist/utils/shell.js:69-73`） |
| 找 git 的环境变量 | `MORI_GIT_PATH`：有值时只试这一个路径，文件不存在为 `missing` | `kernel/git.ts` | App 测试要能做出没装 git（开发机都装着 Git for Windows）；照 `MORI_USER_DATA` 的写法，只给测试用 |
| 没找到 git 时再找 | 每次 `workspace.status` 命令（只看文件是否存在） | `kernel/git.ts` | 装好 git 后点 Refresh 就能用；别处不重找，不起多余的进程 |
| git 进程超时 | `--version` 5 秒；`rev-parse`、`status`、给界面的 `diff` 10 秒；快照与恢复里每个进程 120 秒；删除会话的 `prune` 300 秒 | `kernel/git.ts` | status 实测 0.13 秒，10 秒足够大仓库；快照的第一次 `add` 在 2 万个文件时约 50 秒（u-a8 按 3 万个 76 秒推算），120 秒留余量 |
| git 输出上限 | `status` 4 MB；其他 16 MB；stderr 64 KB | `kernel/git.ts` | 限内存；status 默认把未跟踪目录收成一行，4 MB 约 5 万条 |
| git 状态列出的条数 | 500 | `kernel/workspace.ts` | 右栏看得过来；`total` 给出全部条数 |
| 刷新去抖 | 500 毫秒（只对工具执行完这一个时机） | `kernel/workspace.ts` | 一连串命令只读一次；其余时机是你的操作或一轮结束，立即读 |
| 认出“不是 git 仓库” | 退出码 128 且 stderr 含 `not a git repository`（`LC_ALL=C`） | `kernel/workspace.ts` | 退出码分不出“不是仓库”和 `dubious ownership` 等错误；固定英文提示后按原文判断 |
| 快照目录的环境变量 | `MORI_SNAPSHOTS_DIR` | `main/kernel-process.ts` | 测试要能改；照 `MORI_USER_DATA` 的写法 |
| 内部仓库的归属 | 内部仓库里写 `mori.json { cwd }`；`cwd` 不同（两个工作路径的 `projectDirName` 编码相同）时这个工作路径的快照为 `off`，原因 `Snapshots are off for this folder: its snapshot folder belongs to <cwd>.` | `kernel/snapshots.ts` | 编码会让 `C:\a-b` 与 `C:\a\b` 落进同一个目录；共用内部仓库会把别的文件夹的文件当成改动、Rewind 恢复错 |
| 内部仓库的提交身份与消息 | `Mori <mori@localhost>`、`Mori snapshot`，没有父提交 | `kernel/snapshots.ts` | 隔离配置后没有身份 git 会拒绝；没有父提交，整理时旧的树不被链着留下 |
| 隔离的全局配置 | `<快照目录>\gitconfig`，只有 `[safe] directory = *` | `kernel/snapshots.ts` | 较早的 git 只在 system、global 配置里认 `safe.directory`，写在全局文件里各版本都认；不读你的全局与系统配置（u-a8 的 LFS 过滤器、autocrlf） |
| 内部仓库的 `info/attributes` | `* -text !eol -filter -ident -working-tree-encoding` | `kernel/snapshots.ts` | 按字节存、按字节恢复，`.gitattributes` 的换行与过滤不改恢复出来的文件 |
| 排除的生成 | 问你的 git（`ls-files --others --ignored --exclude-standard --directory`），写成锚定规则 | `kernel/timeline.ts`（生成与转义）、`kernel/snapshots.ts` | 工作路径是子文件夹时复制 `.gitignore`、`info/exclude`、全局排除要改写锚定规则；问 git 与 git status 完全一致，实测 0.13 秒 |
| `.work/`、`.mori/worktrees/` 的排除 | 只在工作路径根（`/.work/`、`/.mori/worktrees/`） | `kernel/timeline.ts` | 别的工作路径的 `.work` 有自己的 `.gitignore`；不误排除你自己叫 `.work` 的子目录 |
| 非仓库的默认排除写法 | `node_modules/` 等不带前导 `/`，任何一层 | `kernel/timeline.ts` | 名单是 proposal 的；这些目录常在子项目里 |
| 已进内部仓库、后来被忽略的文件 | 继续跟踪，不清理 | `kernel/snapshots.ts` | git 对已跟踪文件不看忽略规则；清理要每张多一次调用 |
| 大文件说明 | 列出前 20 个 | `kernel/snapshots.ts`、右栏 | 说明哪些文件 Rewind 不会恢复；限长度 |
| 嵌套仓库的说明 | 树变了时 `git ls-tree -r -z` 找 mode 160000 的条目，`nested` 最多 20 个、`nestedTotal` 记全部；This session 上方一行 `Changes inside nested repositories aren’t tracked: <路径>, <路径>`，多于 20 个时接 ` and <n> more` | `kernel/snapshots.ts`、右栏 | 写规格时定的第 8 条只说列出这些路径；条数上限同大文件说明 |
| 文件数暂停之后 | 每个快照点重新数，降到上限内自动恢复，从新的基准开始 | `kernel/snapshots.ts` | proposal 只说暂停、说明原因；加了 `.gitignore` 就恢复，不另加按钮 |
| 快照超时 | 某个 git 进程超过 120 秒：这一张 `error`（`a snapshot step took longer than 2 minutes`），下一个快照点续做；同一工作路径连续 3 张都超时才暂停到后台进程重启 | `kernel/snapshots.ts` | 分批后超时只丢一批，续做能完成；连续 3 次才停，避免每次运行开始都白等 120 秒 |
| 分批加入的条数 | 新文件多于 2000 个时每批 2000 条，一批一个 git 进程，每批都写进 index | `kernel/snapshots.ts` | 一次 `add -A` 被结束时一点进度都不留；u-a8 实测 3 万个文件 76 秒，2000 个一批远在 120 秒内 |
| 嵌套工作路径的 overlap | 包含或被包含的工作路径上同时有运行时记 `overlap: true` | `kernel/snapshots.ts` | proposal §13 第 17 条只写同一文件夹；嵌套文件夹的会话写的文件同样进这个会话的快照，不标就会在 Rewind 时不问被覆盖 |
| 增强会话与它的实例 | 不拍快照，不进 `active` | `kernel/snapshots.ts` | 没有右栏、不能 Rewind（记忆规格 §9.6）；它们的改动按别人改的算：你空闲时改的不记，在这个会话最近一张快照之后改的 Rewind 时列为 `changed`；和你的会话同时运行时改的记进那一段、不标 `overlap`（同外部程序改的） |
| 由 custom 消息开始的运行 | 没有起始消息、没有 `run` 记录；改动归你最近的消息 | `kernel/timeline.ts` | `before_agent_start` 的 `messageType: 'custom'`；不这样，运行中插话的消息会被当成起始消息 |
| 进行中的运行的开始快照 | `refs/mori/s/<会话 id>/run/<提交>` 保住，写 `run` 记录时换掉 | `kernel/snapshots.ts` | 只改了 gitlink 的段不写记录，开始快照可能没有 ref，被别的会话删除时的 `prune` 删掉 |
| 恢复那一段（P→Q、P'→Q'） | 恢复动过的文件不记；其余文件照常记给还在跑的别的会话 | `kernel/timeline.ts` | 整段不记会丢掉同时在跑的会话的改动；整段都记会把恢复当成它们的改动 |
| 目录 junction | 当普通目录，照 git 的行为跟进去拍、经它恢复，不另处理 | `kernel/snapshots.ts` | git 自己就这样（复核时实测）；与路径闸按字面判断一致；要排除就得每张快照多遍历一次目录 |
| 你在这个会话空闲时手改的文件 | 之后这个会话又跑过一轮、再 Rewind 到更早的轮时被直接覆盖，不进冲突列表；保险快照与 Undo 能找回 | `kernel/rewind.ts` | 照 proposal §5.3 的两种冲突（最近一张快照之后改的、同时运行时改的），不另加一种 |
| 整个工作路径被你的 git 忽略 | 快照是空的（排除写成 `/*`） | `kernel/timeline.ts` | 与 git status 一致（proposal §4“排除的文件和 git status 相同”） |
| 一段记录的文件数 | 500，`total` 记全部 | `kernel/snapshots.ts` | 限会话文件的大小；Rewind 用 git 补全 |
| 树没变 | 不建新提交，沿用上一张 | `kernel/snapshots.ts` | 空闲时的快照不增加对象和 ref |
| 段的归属 | 段开始时的“当前轮”；会话自己运行开始的那一段归起始消息 | `kernel/timeline.ts` | proposal 说“当时那一轮”；按段开始算，排队、插话的消息不会把整次运行的改动拿走 |
| 会话里还没有你的消息时的段 | 先留着（只在内存里），记进之后写下的第一条你的消息；那时的叶子已不在当前分支上时丢掉（2026-10-27 注：负责人不在时按推荐定，待复核） | `kernel/timeline.ts` | 协作模式分开时立项在对话写下你的消息之前就派出 task，task 的第一段改动落在这时；不记就违反 FS-11、FS-14 |
| 运行记录的写入时机 | 结束快照做完时；运行中崩溃就没有 | `kernel/snapshots.ts` | 这时消息、`mori.wake` 都已写下，能判断起始消息是不是你的 |
| 有序退出 | 等快照队列，受主进程 3 秒上限 | `kernel/index.ts` | 被中止的运行的结束快照多半 1 秒内做完；不延长退出 |
| 运行开始的快照被停止 | 结束它的 git 进程，这次不登记、不拍结束快照，没有 code restore | `kernel/snapshots.ts`、`sessions.ts` | 第一张可能几十秒，停止要立刻生效；pi 在 `agent_start` 就中止，没有工具执行 |
| `mori-snapshots` 的位置 | `mori-approval` 之后、`mcp` 之前，必需 | `kernel/sessions.ts` | 没有它就没有快照，Rewind 会恢复错；同其他必需扩展 |
| 整理的命令 | `git prune --expire=now`（不 `gc`） | `kernel/snapshots.ts` | 对象本来就是散的（`gc.auto=0`），prune 快且不重新打包 |
| This session 的顺序 | 新的轮在上；轮里按文件第一次出现 | 右栏 | 最近的改动最常看 |
| 轮的编号 `Turn <n>` | 当前分支上第几条你的消息，不算 `[Mori]` 投递；会话引用的 Turn N 用同一个计数（`turnNumbers`，投递的内容接到前一轮里）（2026-10-27 注：负责人不在时按推荐定，待复核） | 右栏、Rewind 通知、会话引用 | 轮只挂在你的消息上；两处一个编号，右栏的 Turn 3 与引用芯片的 Turn 3 指同一条消息 |
| 运行开始的快照的阶段行 | `Taking a snapshot… · <秒数>`，只为用户会话自己的运行显示 | `kernel/snapshots.ts`、`StageLine.tsx` | proposal 没给；第一张可到几十秒，发出消息后阶段行不能一片空白；照模型层等待的写法 |
| Rewind 通知的文字 | `Restored code to before turn <n> · Undo` 等（§5.9、fs-rewind.md），不用 proposal §5.3 图里的 `… before this message` | 对话流 | 通知在对话流末尾，恢复对话后那条消息也不在了，“this message”指不到 |
| 这条消息恰是叶子时恢复对话 | 导航到它的父条目；父条目是 user 消息、`custom_message` 或没有时失败 | `kernel/rewind.ts` | pi 对“已在目标上”什么都不做（`app/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:3240-3243`） |
| Rewind 进行中再 Rewind | 拒绝，`This session is already rewinding.` | `kernel/rewind.ts` | 第二次要基于第一次的结果算计划 |
| 文件行的状态与行数 | 按这一轮第一次与最后一次出现定 A/M/D，建了又删记 D；行数是各段之和 | `renderer` 的归组函数 | 不为显示多跑 git；diff 按这一轮的两端算 |
| `+N −M` | 当前分支上全部 `changes` 记录之和；只恢复代码不减；窄栏不显示 | `ChatPane.tsx` | 与 This session 一致，不另读 git |
| 点 git 状态里的文件 | 在阅读器里打开 | 右栏 | proposal 没给；阅读器已有，不新加 diff 命令 |
| 子文件夹的 git 状态 | 列整个仓库，路径相对仓库根 | `kernel/workspace.ts` | 同在子文件夹里跑 `git status` |
| No code restore 那一行 | 只在这条消息之后有改动时显示 | 菜单 | 没有改动时恢复代码本来就不显示 |
| Undo 提供到 | 之后出现新的消息条目、或又做了一次 Rewind | 菜单与通知 | proposal 只说能 Undo；之后再撤销会和新的改动纠缠 |
| Undo 的范围 | 同时把对话回到 Rewind 之前（那次恢复过对话时） | `kernel/rewind.ts` | Undo 是撤销整次 Rewind；只撤代码会留下新代码配旧对话 |
| 只恢复对话 | 没有 Undo | 菜单与通知 | Undo 靠保险快照（proposal §5.3） |
| 文字回到输入框 | 放在已有草稿之前，引用芯片恢复 | `state/actions.ts` 的 `putBackQuoted` | 沿用“Put your last message back”的做法 |
| 冲突列表与记录里的文件列表 | 各最多 200 条，另记总数 | `kernel/rewind.ts`、对话框 | 限长度；Undo 用 git 重新算集合 |
| 恢复失败 | 整批失败时逐个再试，失败的列出 | `kernel/rewind.ts` | 一个被锁的文件不让其余的都恢复不了 |
| Rewind 进行中发消息 | 拒绝，原文见 §5.10 | `kernel/sessions.ts` | 恢复到一半时开始新的运行，快照会夹在中间 |
| Rewind 进行中关闭、归档、删除或 Check again | 拒绝，原文同 §5.10 的 `This session is already rewinding.`；界面先在本地拒绝，拒绝启动卡的 `Check again` 不可用 | `kernel/sessionWorkspace.ts`、`state/projects.ts`、`BlockedCard.tsx` | 关闭会释放 pi 会话，恢复到一半时会写进已删掉或重开的会话文件；用规格已有的一句，不另造（2026-10-27 注：负责人不在时按推荐定，待复核） |
| 两项都没选 | `rewind` 命令失败：`Choose code, conversation or both to restore.` | `kernel/rewind.ts` | 菜单不会这样发，命令要能自检；规格没给原文（2026-10-27 注：负责人不在时按推荐定，待复核） |
| 扩展取消移动对话 | `An extension cancelled moving the conversation.`：只恢复对话时是命令的错误；已恢复代码时为 `Couldn’t restore the conversation: …` | `kernel/rewind.ts` | 只有扩展的 `session_before_tree` 会让 pi 返回 cancelled；规格没给原文（2026-10-27 注：负责人不在时按推荐定，待复核） |
| 恢复之后的快照 Q 失败 | 照样写 `mori.rewind`（`post: null`），提示 `Couldn’t take a snapshot: <原文>`，这次没有 Undo | `kernel/rewind.ts`、`state/rewind.ts` | 文件已经恢复，不能当没发生；没有 Q 时 Undo 分不出之后的改动（2026-10-27 注：负责人不在时按推荐定，待复核） |
| 三个及以上需求还开着 | `Requests 1, 2, and 3 are still open. …`（牛津逗号；两个时 `Requests 1 and 3 …`） | `kernel/rewind.ts`、`state/rewind.ts` | docs/v0/ui-strings.md 的列表写法；规格只给了两个的例子（2026-10-27 注：负责人不在时按推荐定，待复核） |
| 只动 ref 的 git 命令的进程目录 | `for-each-ref`、`update-ref`、`prune` 以内部仓库的目录为 `cwd` 与 `--work-tree`（其余命令仍是工作路径，§4.2） | `kernel/snapshots.ts` | 删除会话时工作路径可能已经不在，§4.7 要照样能整理（2026-10-27 注：负责人不在时按推荐定，待复核） |
| 没有 `LOCALAPPDATA` 时的快照目录 | `<主目录>\AppData\Local\Mori\snapshots`，记一行日志 | `main/kernel-process.ts` | Windows 总设这个变量；缺了时用它的默认位置（2026-10-27 注：负责人不在时按推荐定，待复核） |
| 结束 git 之后输出一直不关 | 再等 2 秒，结果按被结束算（退出码 null），日志 `[kernel] git <子命令> in <cwd>: its output stayed open after it was stopped` | `kernel/git.ts` | git 的子进程拿着管道时 `close` 不来；不能把读到一半的输出当成功（2026-10-27 注：负责人不在时按推荐定，待复核） |
| 第一份 git 状态到之前 | 不显示 Rewind、Undo 与 `+N −M`（按 git 不可用算） | `state/workspace.ts` | 打开后马上就读；先显示再收回会在没装 git 的机器上闪一下（2026-10-27 注：负责人不在时按推荐定，待复核） |
| 恢复时挡路的 | 上级目录是文件、链接或联接：`A file is in the way.`；文件的位置是有内容的目录：`A folder is in the way.`；只有空目录时删掉再恢复 | `kernel/rewind.ts` | `git restore` 会删掉挡路的目录与文件，里面可能有没记下的内容；规格没给原文（2026-10-27 注：负责人不在时按推荐定，待复核） |
| Undo 的文件集合 | `diff(safety, post)` 与那次恢复的集合取交；说不准的按 `overlap` 问 | `kernel/rewind.ts` | 恢复期间别的会话改的文件也在 diff 里，只按 diff 撤销会把它们悄悄改回去（2026-10-27 注：负责人不在时按推荐定，待复核） |
| 结束 git 进程 | 整棵进程树（`taskkill /F /T`） | `kernel/git.ts` | Git for Windows 的 `cmd\git.exe` 是启动器，只结束它时真正的 git 拿着锁继续跑（2026-10-27 注：负责人不在时按推荐定，待复核） |
| 内部仓库调用的 git | 找到的是 `<安装目录>\cmd\git.exe`（Git for Windows 的启动器）时用 `<安装目录>\mingw64\bin\git.exe`（没有时 `clangarm64`、`mingw32`，都没有时用启动器）；你的仓库的调用照旧用启动器 | `kernel/git.ts` | 启动器每次多起一个进程（本机实测每秒能起的 git 从约 74 个到约 97 个）；内部仓库的调用用隔离的配置、不跑过滤器与钩子，不需要启动器设的 PATH；你的仓库的 LFS 等过滤器要它（2026-10-27 注：负责人不在时按推荐定，待复核） |
| 结束 git 后等 `close` 的宽限 | 从 taskkill 退出时算起，taskkill 最多等 10 秒 | `kernel/git.ts` | 机器忙时 taskkill 自己就要一两秒；从调用 taskkill 时算会把还在结束中的进程当成管道一直不关（2026-10-27 注：负责人不在时按推荐定，待复核） |
| 关闭会话时的结束快照 | 关闭（Close、Archive、Delete、Check again 重新打开）先等这个会话自己的结束快照写完；会话文件已经不在时不写记录、记日志 | `kernel/sessionWorkspace.ts`、`kernel/snapshots.ts` | 否则删掉的会话文件会被晚到的记录重新建出来（2026-10-27 注：负责人不在时按推荐定，待复核） |
| **§6 路径闸** | | | |
| 链接与目录联接 | 只对词法上在工作路径里的目标取真实路径：最近一个 `lstat` 看得到的上级取 `fs.realpathSync.native`，接上还不存在的段；工作路径本身也取真实路径；词法上在外面的直接算外面，不碰文件系统 | `kernel/pathGate.ts` `realTarget` | 照 Claude 按写入最终落到的位置判断；不碰外面的路径，网络路径不会让 Windows 送出凭据；外面的链接指回里面只会多问 |
| 真实路径取不到 | `realpath` 失败或 `lstat` 报 `ENOENT`、`ENOTDIR` 以外的错：按工作路径外处理，记日志 | `kernel/pathGate.ts` | 悬空的链接、成环、没有权限时看不出落到哪里，按要问处理（Claude 在这种情况下拒绝操作；Mori 交给你决定） |
| “在不在里面”的写法 | 照 pi 的 `getCwdRelativePath`：`relative` 为空，或不等于 `..`、不以 `..` 加分隔符开头且不是绝对路径 | `kernel/pathGate.ts` `insideDir` | 现有写法把 `..notes` 这种名字算在外面；与 pi 判断“在不在 cwd 里”的写法一致 |
| 删掉工作路径本身 | 只有命令里 `remove` 为真（删除、移走）的目标是工作路径本身或上级时算受保护；写进工作路径（`cp a.txt .`）算 `inside` | `kernel/pathGate.ts` `classifyTarget` | proposal §4 只说“删掉工作路径本身也算”；不分开的话 `cp`、`mv`、`Copy-Item` 到 `.` 每次都按受保护问 |
| 一个调用解析的写入目标 | 最多 100 个，之后的记作看不出（`unresolved`） | `kernel/pathGate.ts` | 判断在后台进程里同步做，文件系统调用要有上限；多出来的按写到外面问，只会多问 |
| 分类出错 | 记日志，按 scope `outside`、一个 `unresolved` 目标处理（出卡或没人能批时拒绝） | `kernel/approval.ts` | 异常分支要记日志（AGENTS.md）；不让 pi 把异常变成 `Extension failed, blocking execution` |
| 停止中 | 只放过 `duty` 与 `read`；写 `.work` 也拒绝 | `kernel/approval.ts` | 同现在只放过 `FREE_TOOLS`；停止后不再执行写入 |
| 段名比较 | 去掉流名（`:` 之后）与末尾的 `.`、空格，不分大小写 | `kernel/pathGate.ts` | Windows 打开文件时同样处理，`.git.`、`.GIT` 也是 `.git` |
| 受保护名单 | §6.5 的表（Claude 2026-10-26 的名单，加 `.mori`、`.pi`、工作路径本身与它的上级） | `kernel/pathGate.ts` `PROTECTED_DIRS`、`PROTECTED_FILES` | proposal §4、§12 第 7 条照 Claude；完整名单由规格定 |
| 名单在工作路径外也用 | 工作路径外的目标按完整路径比名单，命中的按受保护（不能按目录放行） | `kernel/pathGate.ts` | 按目录放行是 Mori 自己的做法；不这样的话放行一次就能不问地改 `~\.gitconfig`、别的仓库的 `.git\hooks` |
| 按目录放行的范围 | 只含直接放在目录里的目标，不含子目录 | `kernel/approval.ts` | proposal §9 第 2 条“只放行那一个目录”；放行 `..` 的上一级时不会顺带放行旁边的整个目录树 |
| 没有按目录放行的情况 | 有 `protected`、`unresolved`、`leaves`、`unanalyzed` 目标，或要放行的目录（目标的上一级；`into` 时目标本身）是盘符根、共享根 | `kernel/approval.ts` | 看不出目标、换了目录或分析不了时不知道放行哪个目录；放行整个盘符根等于不再问 |
| 命令分析不了（`ok: false`） | 记一个理由 `unanalyzed` 的目标（scope `outside`）：卡上一行 `Couldn’t analyze this command: <reason>`，给模型的 `<why>` 为 `can't be analyzed: <reason>`；收窄（§8.4）当成看不出的写入 | `kernel/pathGate.ts`、`ApprovalCard.tsx`、`kernel/limits.ts` | §7.8 把它按写到外面处理；与 `unresolved` 的原因行分开，说明的是“分析不了”而不是“看不出路径” |
| 答错了选项时的命令错误 | `Allow for this session doesn’t apply to writes outside the working directory or to protected paths.`；`This request can’t be allowed by folder.`；`Give either toolName or dir.` | `kernel/approval.ts`、`kernel/sessions.ts` | 界面按请求只给对的按钮，这几条只在界面与后台进程不一致时出现 |
| 原因行 `unresolved`、`leaves` 的写法 | `Writes to a path Mori can’t resolve: <text>`、`Runs outside the working directory: <path 或 text>` | `renderer/src/components/ApprovalCard.tsx` | proposal §6 只给了 outside 与 protected 两种；看不出目标、换了目录时显示的是原文而不是路径，要另一种说法 |
| 命令在 Ask each time 下 | 总是问（scope 为 `inside` 时可按工具名放行），哪怕目标只在 `.work` | `kernel/approval.ts` | 命令能做的不只认出的写入；proposal 的“写 `.work` 不问”指 `edit`、`write` |
| 按工具名放行命令的小字 | `You won’t be asked again for commands in this session, unless Mori can’t analyze a command or detects that it writes outside the working directory or to a protected path, or changes to a folder outside it.` | `renderer/src/components/ApprovalCard.tsx` | 列出放行之后仍出卡的全部情况（§7.8 分析不了；§6.4 写到外面、受保护路径、换到外面），按下之后又出卡时与刚读到的承诺一致 |
| 卡上的目标行 | 最多 5 行，多的写 `and {n} more` | `renderer/src/components/ApprovalCard.tsx` | 一条命令可能有很多目标，卡不能撑满一栏 |
| 拒绝原文里列的目标 | 每种最多 5 个，多的写 `and <n> more` | `kernel/approval.ts` | 同上，控制工具结果的长度 |
| 没人能批时的拒绝原文 | §6.15 | `kernel/approval.ts`（开头 `Denied by Mori: ` 在 `shared/workspace.ts` 的 `DENIAL_PREFIXES`） | proposal 没给原文 |
| Full access 的悬停说明 | `Edits, writes, and commands inside the working directory run without asking.` | `renderer/src/components/PermissionMenu.tsx` `modeNote` | 照现在用当前模式的说明，取确认框第一句的现在时 |
| Ask each time 的身份句 | 与现在逐字相同 | `kernel/memoryText.ts` | 仍然准确（“may wait”）；身份段仍因 §7 的 `.work` 一句而变，fixture 照样重录 |
| Full access、没人能批的身份句 | §14 的两句 | `kernel/memoryText.ts` | proposal §10 只说“按模式改写”，没给原文 |
| 有新字段的 fixture | 载荷变了的重录，不给它们补默认值；回放桥只为会话信息里界面新加的字段补 synthetic 的空值（同 `teamInfo`） | `tests/fixtures/m2/*` 与 m3–m6 里带批准请求的、`tests/fixtures/tb/tb-approval.json` 等；`tests/ui/harness/replay.js` | 批准请求的事件改了（AGENTS.md 第 2 条：会话的事件有变化时重录）；只缺界面字段的录制（m1、v1、md）模型看到的没变 |
| **§7 命令分析与 .work** | | | |
| 解析失败怎么算 | 按写到外面（出卡；没人能批的会话直接拒绝） | `approval.ts`（§6 用 `ok: false`） | Claude 的 worktree 隔离对看不出 git 用法的命令形状同样拦下（§7.7 的 Claude 文档）；放行会漏掉复合结构里认得出的写法。Ask each time 下命令本来就问；Full access 下只多一张卡。按语料统计（FS-55）再定 |
| 认得出的写法名单 | §7.5 的名单：proposal §5.1 列的，加上 Claude 认的 `touch`、`rmdir` 与重定向的各种写法，加上同类的 `ln`、`Add-Content`、`New-Item`、`Rename-Item`、`Tee-Object` | `commandScan.ts` | proposal §11 把“命令分析覆盖的写法”留给规格；名单外的照常跑。按语料统计（FS-55，proposal §14）再定 |
| 命令文字的上限 | 1,000,000 个字符，超过为解析失败 | `commandScan.ts` `SCAN_MAX_CHARS` | 资源有上限；分析时间与长度成正比，目标是 1 MB 一次不超过 500 ms（FS-49 量；2026-10-27 注：负责人定，原为 200 ms） |
| 嵌套的上限 | 32 层（括号、替换、嵌套 shell、eval 合计；包装命令、函数体、coproc 与 PowerShell 赋值的右边同样算一层（2026-10-27 注：实现时补充）），超过为解析失败 | `commandScan.ts` `SCAN_MAX_DEPTH` | 防止递归过深；嵌套这么深的真实命令少见 |
| 命令名或命令文字来自变量、替换或输入 | 解析失败 | `commandScan.ts` | 运行前看不出要跑什么，同“分析不了” |
| `-EncodedCommand`、`env -C` / `-S`、PowerShell 的 `-WorkingDirectory` 与不认识的选项 | 解析失败 | `commandScan.ts` | 解码或换目录会让解析不准；这些写法少见，宁可问 |
| HOME | 不当已知变量：`~` 与 `$HOME`、`$env:USERPROFILE` 都看不出来 | `commandScan.ts` | proposal §5.1 把 `~` 列为看不出来（照 Claude）；`$HOME` 同值，同样处理 |
| `$PWD` | 当作当前目录 | `commandScan.ts` | 分析时本来就知道当前目录 |
| msys 根下的路径（`/tmp`、`/usr`…） | 看不出来（`shell-path`） | `commandScan.ts` | 本机实测 `/tmp` 是用户临时目录，不跟 TMP 走；其余落在 Git 的安装目录 |
| 不是目标的设备路径 | `/dev/null` `/dev/stdout` `/dev/stderr` `/dev/stdin` `/dev/tty` `/dev/fd/<n>`、PowerShell 的 `$null` | `commandScan.ts` | 照 Claude（`/dev/null` 与 fd 形式跳过，https://code.claude.com/docs/en/permissions#redirections） |
| 换目录的报告 | `scanCommand` 对每一次换目录之后运行的非只读命令都给 leave（字面的 `dir`），不判断在不在工作路径里；§6.4 按真实路径丢掉仍在里面的 | `commandScan.ts`、`pathGate.ts` | 按字面判断会漏掉指向外面的目录联接（`cd <联接> && npm i`）；`scanCommand` 不收回调，保持纯函数 |
| bash 的 cd 在多节管道里、`&` 后台里 | 不改当前目录 | `commandScan.ts` | bash 的子 shell 语义（本机实测） |
| PowerShell 的 Set-Location | 一直延续，括号与脚本块不隔开 | `commandScan.ts` | PowerShell 的位置属于运行空间（本机实测） |
| 看不出来的当前目录 | `cd`（无参数）、`cd -`、多个操作数、`pushd`（无参数或 `±N`）、`popd` 栈空、PowerShell 的 `Set-Location`（无参数）、`cd -`、`cd +` | `commandScan.ts` | 运行前不知道去哪 |
| 只有赋值的 `GIT_DIR=` / `GIT_WORK_TREE=` | 当作 export | `commandScan.ts` | 偏严，写法少见 |
| 只读名单 | §7.7 的三张名单 | `commandScan.ts` `READ_ONLY_COMMANDS` | proposal 只举了 `ls`、`cat`、`git status`、`git log`；名单取不写文件、不跑别的程序的常用命令，按语料统计再调 |
| PowerShell 的参数表 | 5.1 与 7 的并集（本机 `Get-Command` 读出）；参数名不认识、有歧义、多出位置参数、splatting → 一个看不出来的目标 | `commandScan.ts` | PowerShell 多半会报错不执行，但动态参数可能没列全，宁可问 |
| PowerShell 的通配符 | `LiteralPath` 以外的参数里的 `*` `?` `[`（引号里也算）→ 看不出来 | `commandScan.ts` | `-Path` 按通配符展开，可能写到几个文件 |
| PowerShell 的提供程序路径 | 两个字母以上的驱动器（含 `Temp:`）、`名字::` → 看不出来；`FileSystem::` 去掉前缀 | `commandScan.ts` | 不是工作路径里的文件，偏严 |
| 以 `\` 开头的路径（两种 shell） | 当前目录所在盘的根下 | `commandScan.ts` | PowerShell 与 Git Bash 都这样解析（本机实测） |
| 盘符相对路径（`C:x`，含 bash 里不加引号的 `C:\x`） | 看不出来（`drive-relative`） | `commandScan.ts` | 每个盘的当前目录在运行前不知道；不加引号的 `C:\x` 在 bash 里其实是 `C:x`，多半是写错了，问一次 |
| 命令名的大小写 | 一律不分大小写（保留字除外） | `commandScan.ts` | Git Bash 找外部程序不分大小写（本机实测 `RM` 跑的是 `rm`）；内建命令按不分算只会多问 |
| 落进目录（`into`） | 只按文字认：`-t` 的值、两个以上的源时的目标、以分隔符结尾或最后一段是 `.` / `..` 的目标、Copy-Item / Move-Item 省略的 Destination | `commandScan.ts` | 纯函数不读文件系统；§6 的按目录放行据此不放宽到上一级（proposal §13 第 1 条）。看不出是不是目录时按文件，放行宽一级 |
| 结构缺结束词 | `fi`、`done`、`esac`、bash 的 `}` 缺了到末尾自动结束；引号与括号（含 PowerShell 的 `{`）缺了才失败 | `commandScan.ts` | 少报解析失败：bash 遇到没结束的结构报语法错、这一段不跑，按写入算只会多问；前面完整的命令照样会跑，必须分析 |
| here-doc 没有结束行 | 正文到文字末尾 | `commandScan.ts` | 同 bash（只警告，本机实测） |
| xargs 与 `find -exec` 的输入 | 没有替换串时在末尾补一个看不出来的操作数；`{}` 与替换串看不出来 | `commandScan.ts` | xargs 把输入的项接在参数后面 |
| 写入去重 | form、text、path、remove 都相同的只留第一个 | `commandScan.ts` | 卡上不重复 |
| leave 去重 | form、text、dir、command 都相同的只留第一个 | `commandScan.ts` | （2026-10-27 注：负责人定，原来不看 `dir`：会把换到别处的第二次 leave 去掉，少问一次） |
| eval 与 Invoke-Expression 里的 `cd` | 延续到后面（同真实的 bash、pwsh：它们在同一个 shell 里跑）；`bash -c`、`pwsh -c` 等嵌套 shell 仍隔开 | `commandScan.ts` | （2026-10-27 注：负责人定，原写 eval 里的 `cd` 不影响外面）`eval 'cd ..'; npm i` 照实际执行的位置出 leave |
| 结果条数的上限 | writes 与 leaves 合计 1000 条，超过为解析失败（`the command is too long`） | `commandScan.ts` `SCAN_MAX_RESULTS` | 资源有上限；批准卡最多列 5 个目标，真实命令远不到这么多（2026-10-27 注：实现时补充的临时默认值） |
| pushd 栈的上限 | 1000 层，超过为解析失败（`the command is too long`） | `commandScan.ts` `SCAN_MAX_STACK` | 防止目录栈无限增长（2026-10-27 注：实现时补充的临时默认值） |
| 路径长度的上限 | 超过 32,767 个字符的路径看不出来（`unknown: directory`），不算解析失败 | `commandScan.ts` `MAX_PATH_CHARS` | Windows 长路径的上限；更长的不可能是真实路径（2026-10-27 注：实现时补充的临时默认值） |
| 路径总工作量的上限 | 一次分析里解析出的路径、leave 的目录与文字、bash 的 `$PWD` 合计超过 64,000,000 个字符时为解析失败（`the command is too long`） | `commandScan.ts` `SCAN_MAX_PATH_WORK` | 一条很长的 `cd` 之后每条命令都要处理这个目录，不设上限时最坏要十几秒（实现时实测）（2026-10-27 注：实现时补充的临时默认值） |
| 互斥分支的当前目录 | `||`、`if`/`else`、`case` 各分支的当前目录合起来记成几种可能，之后的每条简单命令（PowerShell 为管道的每一节）按每种可能分析一遍；最多 8 种（`SCAN_MAX_STATES`），多了合成一个看不出来的当前目录 | `commandScan.ts` `SCAN_MAX_STATES` | 按顺序套用各分支的 `cd` 会让记下的目录是工作路径、实际却在外面（审查时实测 `cd sub || cd ..; rm -rf proj`）（2026-10-27 注：实现时补充的临时默认值） |
| 循环体 | 循环体（bash 的 while/until/for/select、PowerShell 的 foreach/for/while/do 与 switch）先分析一遍；里面换了目录时，最外层的循环再从看不出来的目录分析一遍 | `commandScan.ts` | 第二次起循环体在换过的目录里跑，`for …; do npm i; cd ..; done` 的 `npm i` 第二次在外面（2026-10-27 注：实现时补充的临时默认值） |
| pushd / popd / dirs 的选项 | `pushd -n` 只入栈不换目录；`popd -n` 只出栈；`popd +N` / `-N` 之后目录栈（不带 -n 时还有当前目录）看不出来；`dirs -c` 清空栈 | `commandScanBash.ts` | 同 bash 的行为；不认的话会以为回到了工作路径（2026-10-27 注：实现时补充的临时默认值） |
| 包装命令的选项 | `exec`、`nice`、`timeout`、`env` 的短选项按 GNU 合写解析（`-vs KILL`、`-n5`）；`env` 合写里有 `C` 或 `S` 时解析失败；这几个命令不认识的长选项一律解析失败（`unsupported option --x`） | `commandScan.ts` | 漏认包装后面真正的命令就漏掉它的写入；不认识的长选项可能是缩写的 `--chdir`（2026-10-27 注：实现时补充的临时默认值） |
| `>&WORD` 的 WORD | 只有全部是字面、且是 `数字`、`数字-` 或 `-` 时才算复制文件描述符；含变量、引号拼接的按写文件（值看不出时为看不出来的目标） | `commandScanBash.ts` | bash 按展开后的结果判断，看不出来时按写入从严（2026-10-27 注：实现时补充的临时默认值） |
| 嵌套 shell 的选项位置 | `bash`、`sh`、`pwsh` 的选项位置上有看不出来的词、后面跟着 `-c` / `-Command` 等，或从 stdin、管道读命令时，解析失败（`the command text comes from a variable or input`）；pwsh 7 的 `-EncodedCommand`、`-WorkingDirectory` 同样按解析失败 | `commandScan.ts` | 否则会把 `-c` 后面的命令文字当作脚本名，不分析（2026-10-27 注：实现时补充的临时默认值） |
| PowerShell 的位置函数 | `cd..`、`cd\`、`cd~` 与 `A:`…`Z:` 按内置的换目录函数处理（不看参数）；换到同一个盘不变，换到别的盘当前目录看不出来 | `commandScanPs.ts` | PowerShell 自带这几个函数；当外部程序处理会漏掉换目录（2026-10-27 注：实现时补充的临时默认值） |
| PowerShell 的位置栈 | 从管道取路径的 `Push-Location`、`Set-Location` 目录看不出来（`(paths from input)`）；用过 `-StackName` 之后 `Pop-Location` 一律看不出来 | `commandScanPs.ts` | 命名栈与管道输入在运行前都看不出（2026-10-27 注：实现时补充的临时默认值） |
| 命令名里的通配与花括号 | 不加引号的命令名含 `*`、`?`、`[…]` 或花括号展开时解析失败（`the command name comes from a variable or substitution`）；单独的 `[` 与加了引号的名字照常 | `commandScanBash.ts` | 展开之后才知道跑的是什么（`{rm,-rf,x}`）（2026-10-27 注：实现时补充的临时默认值） |
| 算术里的命令替换 | `$((…))` 里的照 §7.3 不分析（`$((…))` 做目标时按看不出来）；`((…))` 与 `for ((…))` 里的照常分析 | `commandScanBash.ts` | §7.3 只定了算术展开 `$((…))` 的内容不分析，`$(( $(rm ../x) + 1 ))` 这类写法 Mori 看不到，记为已知的限制；`((…))`、`for ((…))` 规格没写，bash 会执行其中的命令替换，照常分析（偏严）（2026-10-27 注：实现时补充的临时默认值） |
| 什么时候建 `.work` | 放行 bash / powershell 调用，或放行写进 `.work` 的 write / edit 之前；每次都检查，不缓存。另外 §11 建 worktree、Initialize git 时建（proposal §5.4） | `approval.ts`、§11 → `workspace.ts` `ensureWork` | 用到时才建，没用过命令的文件夹里不出现；不监视（负责人偏好）；检查很便宜，删掉后能自己恢复 |
| `.work` 建不起来（是文件、只读文件夹、没有权限） | 挡下这次调用并说明原因，记错误日志 | `approval.ts` | proposal 没说；照 AGENTS 第 6 条遇到阻塞就停下来报告，不静默换路线；另一种做法（照常跑、TEMP 不改，在工具结果里说明）是换路线的 fallback，不采用。这样这个文件夹里的命令都跑不了，直到你改名或删掉那个 `.work` |
| `.work/.gitignore` | 内容 `*\n`；只在没有时写（`wx`），从不覆盖 | `workspace.ts` | proposal §4；你改过的保留 |
| 工作路径不在时 | `ensureWork` 什么都不建 | `workspace.ts` | 不把删掉的 worktree 重新建出来 |
| 设哪些变量 | TEMP、TMP、TMPDIR，都指到 `<工作路径>\.work\tmp`；先删掉各种大小写写法；另去掉 CDPATH 的各种大小写写法（不设新值） | `workspace.ts` `workEnv` | proposal 写 TEMP / TMP；TMPDIR 是 Git Bash 的 `mktemp` 与 Python 先看的（本机实测）；继承的 CDPATH 会让 bash 的 `cd 相对名` 换到别处，§7.7 的解析就不准 |
| 命令自己改了 TEMP、TMP、TMPDIR、PWD | 这条命令里（含之后嵌套的 shell、eval 文字）这个名字看不出来（`variable`）：开头的赋值、`env -i` / `-u`、export、只有赋值、PowerShell 的 `$env:` 都算 | `commandScan.ts` | `vars` 是 `spawnHook` 设的值，命令改掉之后不再对（Git Bash、pwsh 实测写到了工作路径外）；偏严，严格说只有嵌套文字看到开头赋值的新值 |
| 命令里设了 CDPATH | 之后 bash 的 `cd` / `pushd` 操作数不以 `/`、`\`、`.`、`~`、盘符开头时目录看不出来；`unset CDPATH` 不恢复 | `commandScan.ts` | bash 对这种操作数先查 CDPATH（Git Bash 实测换到了工作路径外）；偏严，写法少见 |
| PowerShell 外部程序参数里的 cmd.exe 元字符 | 去掉 PowerShell 引号后不含空白、却含 `>` `<` `\|` `&` 的参数，与 `--%`，解析失败 | `commandScan.ts` | `.cmd` / `.bat` 垫片（npm、npx、tsc 等）由 cmd.exe 再解析一遍（pwsh 实测 `npm.cmd --version '>' ..\x` 写出文件）；看不出命令名是不是垫片，按文字从严，§7.13 统计后再定 |
| 换掉的工具 | `bash`、`powershell` 用 `customTools` 换，`defaultActive: false`，工具页来源仍为 Built-in | `workspace.ts` `shellTools`、`resources.ts` `toolSource` | 启用与显示与内置工具相同（§7.11 的核实） |
| `.work` 的清理 | 不清理，不设上限 | — | proposal §9 第 5 条没有后台清理；草稿在里面；工作路径在 OneDrive 里时，命令的临时文件也会被同步 |
| 解析失败的日志 | `[kernel] command not analyzed (<shell>): <reason>`，不写命令原文 | `approval.ts` | 语料统计与排查用 |
| **§8 收窄** | | | |
| `limits` 里 `true` | 与不写相同，不存 | `kernel/limits.ts` `parseLimits` | proposal 的形状只有 `false`；模型写 `true` 时不报错，少一次重试 |
| `limits` 里的键名与未知键 | 键名照顶层归一；未知键丢掉 | `kernel/boardTools.ts` `prepareToolArgs` | 与平行 Agent 规格 §6.2 顶层参数的规则一致，不另立一套 |
| `write_paths` 的项数 | 1–10（JSON schema 的 `minItems`、`maxItems`） | `kernel/boardTools.ts` 的 schema | “缩到几个子目录”；空列表没有意义（要什么都不写用 `write: false`）；10 项写进工作卡也不长 |
| `write_paths` 的写法 | 只认相对路径；出界、整个工作路径报错；归一为 `/` 分隔、末尾 `/`、去重、去掉被包含的；不检查是否存在；一项可以是文件 | `kernel/limits.ts` | proposal 只说“工作路径下的几个子目录”；归一后工作卡、拒绝原文和比较都简单 |
| `write: false` 与别的项同时写 | 去掉 `commands`、`write_paths` | `kernel/limits.ts` | 已经包含在 `write: false` 里 |
| `mcp: false` 的范围 | MCP 工具和扩展注册的、不是职责工具的工具 | `kernel/limits.ts` `checkLimits` | proposal §5.1 把“MCP 和扩展注册的工具”当成一类（看不出写什么）；只关 MCP 时扩展工具就成了对话 Agent “只转达”的缺口 |
| `agent_message.limits` 的去向 | 只在开临时提问时用；发到 task、进座位会话时不用（不合格仍拒绝） | `kernel/teamTools.ts` `agentMessage` | proposal 只说“这个临时提问的实例按它判断”；座位会话本来就被程序收窄 |
| 合并会话在协作模式下的收窄 | `{ write: false, mcp: false }`，拒绝原文用 `RELAY_ONLY` | `kernel/team.ts` `narrowingFor` | 两个席位的收窄取并集；与现在（读取类、没有 MCP）效果相同 |
| 收窄拒绝原文的开头 | task `Not allowed for this task`；临时提问 `Not allowed for this question`；立项 `Not allowed while deciding requests`；结案 `Not allowed while closing a request`；订阅 `Not allowed in a subscription`；对话会话整句 `RELAY_ONLY` | `shared/workspace.ts` `NARROWING_LEADS` | proposal 只给了 task 的例子；写明是谁的限制，“限制是派它的 Agent 或程序定的，不是你定的”；放在 shared 是因为界面要认出它们（`DENIAL_PREFIXES`） |
| 收窄拒绝的规则文字 | §8.4 表 | `kernel/limits.ts` | proposal 的例子 “writes are limited to src/” 加上 `.work/` 与越界的目标，模型知道哪里能写 |
| `write_paths` 怎样比 | 目标按 §6.3 取真实路径、相对工作路径的真实路径，按段比（不分大小写，去掉末尾的 `.` 与空格）；归为 `work` 的总在里面 | `kernel/limits.ts` `checkLimits` | 与 §6 的 `.work`、受保护名单用同一套路径与段名规则，链接与大小写不会让写入绕出列表 |
| 有 `write_paths` 时换到工作路径外执行的命令 | 与看不出的目标一样拒绝（`Mori can’t tell where this writes`） | `kernel/limits.ts` `checkLimits` | proposal §5.1 把它们按写到外面处理；换目录之后写到哪里看不出 |
| 实例的工具白名单 | pi 设置的默认工具 + `mcp__*` + 职责工具，所有种类相同 | `kernel/roles.ts` `instanceTools` | “碰文件的工具对所有 Agent 都一样”；就是现在基座 task 实例的那一组，不新加扩展工具 |
| 工作卡与 `board_read` 的限制写法 | `· Limits: <limitsText>`；没有限制时不写 | `kernel/boardText.ts` | 代替 `· read-only` / `· changes files` |
| 立项段对 `limits` 的建议 | 除非要跑命令或改文件，写 `{"write": false}` | `kernel/boardText.ts` `MARK_LINE` | 保住现在“默认只读”的并行与写入锁行为 |
| **§9 你不在** | | | |
| 后台进程的焦点初值 | `focused = true` | `kernel/away.ts` | 主进程第一次告诉它之前没有窗口，也没有卡 |
| 接上通道时补发一次焦点 | `connectWindow` 发 `port` 之后按当前状态发 `window_focus`，不论值变没变 | `main/index.ts` | 重启的后台进程不知道窗口状态；proposal 只写了“焦点变化时发” |
| “在前台”的判断 | `isFocused() && !isMinimized()`，听 `focus`、`blur`、`minimize`、`restore` | `main/index.ts` | Windows 上最小化一般先失焦，加上 `isMinimized` 防止漏判 |
| 同时挂着的几张卡 | 各自计时，同一时刻到时 | `kernel/away.ts` | 只显示一张，但“你不在”对全部卡都成立 |
| 设置的存放 | `<userData>/away.json` `{ "timeout": "5m" }` | `kernel/away.ts` | 后台进程要用；Mori 没有全应用的设置文件，只为这一项建一个最小的 |
| 设置的位置 | 设置页新增一节 `General`，排在 UI issues 之后 | `SettingsPage.tsx` | 现有三节都不合适；Clean up worktrees 另在 `Storage` 一节（§11.10），两节都留 |
| 改设置何时生效 | 下一次开始计时起 | `kernel/away.ts` | 改设置时窗口在前台，没有正在走的计时 |
| 测试用的时长 | 环境变量 `MORI_AWAY_TIMEOUT_MS` 替换三档时长 | `kernel/away.ts` | 60 秒起的时长让 App 测试太慢；照 `MORI_USER_DATA` 的写法 |
| 倒计时的文字 | `You’re away · Denying in Ns` / `You’re away · Using the recommended options in Ns` / `You’re away · Cancelling in Ns` | 三种卡 | Claude 只说最后 20 秒显示倒计时，原文未知；照 ui-strings 的 “ · ” 写法 |
| 拒绝的工具卡理由 | `No answer while you were away` | `model.ts` `parseRejection` | 同 `You pressed Stop` 的写法 |
| 拒绝原文里的时长 | `60 seconds`、`5 minutes`、`10 minutes` | `kernel/away.ts` | proposal §5.2 的原文写 “within 5 minutes” |
| 实例的拒绝原文 | task 实例、结案会话写 “Mention it in your handoff.”，其余实例同用户会话 | `kernel/away.ts` | 只有这两种有交接单 |
| 提醒不含扩展询问 | 扩展的取消只进界面列表，不进提醒 | `kernel/away.ts` | 模型没发起、也没见过这张卡 |
| 提醒只在正常结束时补 | `outcome === 'completed'` | `kernel/away.ts` | 出错结束时再请求一次多半还会出错 |
| 已交接的 task 实例不补提醒 | `GateOutput.handedOff?.()` 为真（这次运行有成功的 `task_handoff`）时不补 | `kernel/away.ts`、`kernel/instances.ts` | 交接之后的调用一律被拒绝（平行 Agent 规格 §7.1），再跑一次没有用 |
| 提醒清单何时清空 | 这个 pi 会话的 `agent_settled` | `kernel/sessions.ts` | 一次运行里 `agent_start` 会来好几次（§9.8），只有 `agent_settled` 每次运行一次 |
| 焦点消息的日志 | 每收到一次记 `[kernel] window focus: <true\|false>` | `kernel/index.ts` | 让 App 测试核对“值不变时不发”；不加别的测试入口 |
| 提醒条目的 customType | `mori.away_reminder` | `kernel/away.ts` | 与记录 `mori.away_decision` 分开 |
| 记录里参数的截短 | 字符串截到 300 字符，去掉 `content`、`edits` | `kernel/away.ts` | 界面只用它算工具卡标题；不把整份写入内容再存一遍 |
| 扩展询问不闪任务栏 | 只有批准卡与提问卡闪 | `actions.ts` | 现在扩展询问不闪（`app/src/renderer/src/state/actions.ts:362`）；proposal 没要求改 |
| “Decided while you were away” 不进导出与会话引用 | 只在对话流里显示 | 界面 | proposal 只要求在这一轮末尾列出 |
| **§10 ask_user_question** | | | |
| 扩展名与位置 | `mori-question`，mori-memory 之后、mori-approval 之前 | `sessions.ts` | 只在用户会话里；没有 `tool_call` 处理器，放哪里都不影响判断顺序 |
| 不是必需的扩展 | 加载失败时会话照常打开 | `sessions.ts` | 不影响安全；少了它只是不能用卡提问 |
| 文字长度 | `question` 1–500，`label` 1–60，`description` ≤ 300，Other ≤ 2000 字符 | `askQuestion.ts` | Claude 只限 `header` ≤ 12；其余没有公开的上限 |
| `Other` 不能作 label | 不分大小写 | `askQuestion.ts` | 卡上总有 Other（照 Claude），同名会分不清 |
| 多选的推荐项 | 仍是一个 label，你不在时只选它 | `askQuestion.ts` | proposal 的 `recommended` 是一个推荐项 |
| 卡的布局 | 问题按顺序列在一张卡上，最后一个 Submit；不预先选中推荐项 | `AskCard.tsx` | Claude Code 是一题一页再 Submit；一张卡更简单。不预选，免得一下 Enter 就替你选了 |
| 卡的排序 | 批准卡在前；提问卡与扩展询问卡按到达顺序，一次一张 | `ChatPane.tsx` | 沿用“批准卡先显示”（extension-ui.md） |
| Esc | 拒绝回答，工具卡 `Denied · You declined to answer` | `AskCard.tsx`、`model.ts` | 同批准卡 Esc 拒绝、扩展询问卡 Esc 取消 |
| 拒绝回答的原文 | 见 §14 | `askQuestion.ts` | 照 Claude 拒绝工具时“停下来等用户”的意思 |
| 请求 id | `ask-<n>` | `askQuestion.ts` | 与 `approval-<n>`、扩展询问的 `question-<n>` 分开 |
| 多选答案的连接 | `, ` | `askQuestion.ts` | 照 Claude Code 的已知写法 |
| 工具卡 | 标题 `Ask · <各问题的 header，用 , 连接>`（例如 `Ask · Database, Scope`）；等待时 `Waiting for your answer` | `toolTitle.ts`、`ToolCard.tsx` | 现有标题是“动词 对象”（`Run npm test`），`agent_message` 已经有 `Ask <role>`（`app/src/shared/team.ts:578`）；用 “ · ” 隔开，免得 header 读成角色名。状态词沿用阶段行的 `Waiting for your answer` |
| 拒绝回答、停止的结果是错误 | `isError: true`，原文 `ASK_DECLINED_TEXT`、`ASK_STOPPED_TEXT`（`shared/workspace.ts`） | `askQuestion.ts` | 照 Claude Code 拒绝工具调用时的错误结果；界面重新打开时只对错误结果认拒绝（`app/src/renderer/src/state/history.ts:68`） |
| 停止的工具卡 | `Stopped`（不是批准卡停止时的 `Denied · You pressed Stop`） | `transcript.ts`、`history.ts` | 提问不是被拒绝的操作；同其他工具停止时的写法 |
| 不做参数键名归一 | 没有 `prepareArguments` | `askQuestion.ts` | `prepareToolArgs` 只管顶层的键；写错的键由 pi 的校验报错 |
| 提问卡让任务栏闪烁 | 同批准卡 | `actions.ts` | 提问卡同样挡住 Agent |
| 交接选项的长度 | 2–4 项，每项 1–60 字符 | `board.ts` | 与提问卡的选项一致 |
| 强制填写 C 级不带选项 | `tagFormat` 不变 | `handoffForm.ts` | 不改现有的强制填写文字；A、B 级自动带上 |
| **§11 worktree 与 Initialize git** | | | |
| worktree 名字 | 第一条消息里你写的字（跳过引用块）→ NFKD 去附加符号、小写、`a-z0-9` 词、最多 5 个词且不超过 30 个字符；没有词时 `session`；后接 `-` 和 6 个十六进制字符 | `kernel/workspace.ts` `worktreeName` | Claude 用 `<名字>-<6hex>`；proposal 没给取名规则；只用 ASCII 保证分支名合法、路径短 |
| 撞名重试 | 换后缀最多 3 次，之后失败 `<路径> already exists.` | `createWorktree` | 6 位十六进制撞上的机会极小，不值得更多处理 |
| 会话文件夹是联接或 subst | R 与 `<sub>` 从 cwd 的写法推出，它们的真实路径对不上 git 给的仓库根时拒绝（`<sub>` 与 git 的前缀不同时，例如仓库里的子文件夹是联接，按 `The folder <sub> isn’t committed yet…` 拒绝），原文 `This folder’s path doesn’t lead to its repository root <toplevel>, so Mori can’t place a worktree here.`，什么都不改 | `createWorktree` | 照规格按 cwd 的写法推出 R 时，联接进仓库子文件夹的路径会把 worktree 放到仓库外面；规格没给原文（2026-10-27 注：负责人不在时按推荐定，待复核） |
| 删 worktree 文件夹、Initialize git 失败后删 `.git` 的重试 | `fs.rm` 的 `maxRetries: 5`、`retryDelay: 100`：只对 EBUSY、EMFILE、ENFILE、ENOTEMPTY、EPERM 重试，等待线性递增（100…500 ms，合计约 1.5 秒） | `kernel/workspace.ts` `RM_OPTIONS` | Windows 上刚结束的进程（git、杀毒、索引）还占着文件时一次删不掉；同 `renameRetry.ts` 的做法（2026-10-27 注：实现时补充的临时默认值） |
| 归档时读不出 worktree 的改动 | 不删，`error` 为 git 的原文（只记日志），等设置页清理时再问你 | `kernel/workspace.ts` `cleanUpOne` | 读不出就当干净会删掉没提交的文件（2026-10-27 注：负责人不在时按推荐定，待复核） |
| 建 worktree 的超时原文 | 慢步骤（`worktree add`）超过 120 秒为 `timed out after 120 seconds`，其余 10 秒的步骤为 `timed out after 10 seconds`；界面前面加 `Couldn’t create the worktree: ` | `createWorktree` | 同 Initialize git 的写法；规格只给了恢复 worktree 超时的原文（2026-10-27 注：负责人不在时按推荐定，待复核） |
| Storage 里读不出改动的项 | `changes` 为 null（文件夹在、读不出）时这一行不写 `Uncommitted changes` / `No uncommitted changes` | `StorageSection.tsx` | 规格只给了有、没有改动与正被使用三种（2026-10-27 注：负责人不在时按推荐定，待复核） |
| 删除确认框的 worktree 一句的先后 | 正被使用 → 没装 git → 读不出 → 有改动 → 干净；不在或没列出时不加 | `state/worktrees.ts` | 屏幕表各写法同时成立时取对你最要紧的一句（2026-10-27 注：负责人不在时按推荐定，待复核） |
| 建 worktree 中归档、删除 | 拒绝，原文同 §11.5.6 的 `The worktree is still being created.` | `state/projects.ts` | 后台进程同样拒绝；不另造一句（2026-10-27 注：负责人不在时按推荐定，待复核） |
| Storage 清理命令本身失败 | 每个要删的项都列 `Couldn’t delete <branch>: <原因>`，再读一次列表 | `state/worktrees.ts` | 规格只写了逐项失败（2026-10-27 注：负责人不在时按推荐定，待复核） |
| 右栏的 Initialize git… | 后台进程不可用（Starting…、Restarting…、崩溃、打开失败）时不显示（同输入框下一行的入口） | `ChangesPanel.tsx` | 这时确认也发不出 `workspace.initGit`（2026-10-27 注：负责人不在时按推荐定，待复核） |
| 还没保存的 worktree 会话按 Check again | 重建时把原来的 `mori.worktree` 写进新的 SessionManager（仍只有一条） | `worktreeSession.ts` | §11.6 说拥有关系只由这一条表示；不写就丢了，归档、删除时不再处理那个 worktree（2026-10-27 注：负责人不在时按推荐定，待复核） |
| 在 Mori worktree 里再开 worktree | 放在同一个 R 下，不嵌套（切出点按 §0 写规格时定的第 6 条） | `createWorktree` | 照 Claude：fork 出的 worktree 与原来的并列；避免路径越套越长 |
| 第一条消息的文件引用 | 交给 pi 之前，原来 cwd 里的文件引用的 `path` 换到新 cwd 下同样的相对路径（`refsInto`）；`text` 不改 | `startInWorktree`、`actions.ts` | 不换的话界面认不出引用块、整段露出来；发给模型的文字不变 |
| 开关在窄栏 | ≤ 460px 只显示图标 `branch`，名字在读屏名与悬停里；不截短 | `WorktreeToggle.tsx`、`icons.tsx` | 同一档权限、范围、Effort 去掉 ▾；这一项是开关，截短后读不出 |
| exclude 行 | `.mori/worktrees/`（不带开头的 `/`），没有这一行才加 | `createWorktree` | 照 Claude 的 `.claude/worktrees/` |
| `worktree add` / `worktree remove` / Initialize git 的 `add -A`、`commit` 的超时 | 各 120 s | `kernel/workspace.ts` 调 `git.ts` 时 | 检出大仓库比读状态慢得多（本机 788 个文件 1.27 s）；§3 的默认超时是给状态用的 |
| 建 worktree 期间 | 后台进程拒绝这个会话的其他命令（`The worktree is still being created.`），不能停止；界面不能发送、Stop 与输入框下一行不可用，阶段行 `Creating worktree…` | `sessions.ts` `creatingWorktree`；`Composer.tsx`、`StageLine.tsx` | git 检出中途杀掉会留下一半的 worktree；通常只要一两秒 |
| 重建时沿用的设置 | 批准状态（同一个对象）、选择范围、思考强度、会话名、协作模式（按这个顺序设回） | `startInWorktree` | 这些是你在第一条消息前选的；Check again 的重建不沿用，这里不沿用就会在你眼前变回默认 |
| 建 worktree 失败的清理 | `worktree remove --force --force`、`worktree prune`、还在就删文件夹、`branch -D`；每步失败只记日志；配置和 exclude 行留着 | `createWorktree` | 实测失败的 `worktree add -b` 也会留下分支；超时被结束的 add 留下锁，一个 `--force` 删不掉（§11.1） |
| 没装 git 时删除 worktree 会话 | 照常删会话，worktree 不动，确认框写明 | `deleteSession` | 会话总能删；不用 git 删 worktree 会留下登记 |
| 归档时删 worktree 的结果 | 不显示，只记日志 | `projects.ts` `archiveSession` | 归档不确认（方案 5.3）；留下的在设置页能看到 |
| 删除时 worktree 正被别的开着的会话用 | 不删 worktree，照常删会话，确认框写明 | `deleteSession`、`worktrees.cleanUp` | 删了会让那个会话的工具全部失败 |
| “干净”的判断 | `git --no-optional-locks status --porcelain` 为空；被忽略的文件（`.work/`、`node_modules`）不算，删 worktree 时一起删 | `worktrees.list`、`cleanUp` | 与 `git worktree remove` 自己的判断相同（实测） |
| 恢复 worktree | 登记里还有它（含 `locked` 的）时先 `worktree remove --force --force` 再 `prune`，然后 `worktree add <path> <branch>`（120 s；失败时清掉建了一半的，不删分支）；文件夹在而登记没有时打开失败、不替你删；按 `worktreeOf(cwd)`，不要求 `mori.worktree` | `openFromFile` | 实测手工删掉的 worktree 不清登记就 add 不上，`prune` 不删锁着的登记；同一 worktree 里另开的会话也能打开 |
| 删 worktree 后文件夹还在 | `fs.rm` 递归删掉（Node 不跟进联接）；仍在则 `removed: false` 与原文 | `worktrees.cleanUp` | 实测里面有目录联接时 `git worktree remove --force` 只删登记；留下的文件夹让这个会话再也恢复不了 |
| 共用配置里有 `core.worktree` | 不建 worktree，说明原因，什么都不改 | `createWorktree` | 实测这时链接出去的 worktree 以主文件夹为工作树，Agent 在里面提交的是主文件夹；挪配置是你的仓库的事 |
| Initialize git 中途失败 | 结束 git 后删掉本次 `git init` 建的 `.git`，文件夹回到之前；本来就有 `.git` 时不删 | `initGit` | 被结束的 `git add` 在你的新仓库里留下 `index.lock`，仓库留着你就得自己清锁；那个 `.git` 里只有 git 写的文件 |
| 界面的本次信任回答 | 按 `projectFolder(cwd)` 记（记住到 `trust.json` 的照 pi，不改） | `renderer/src/state/trust.ts` | proposal §13 第 11 条没列信任；在主文件夹回答过，同一次运行里不再为它的 worktree 问 |
| 侧栏分支标签 | 建 worktree 时的分支名（从路径推出），不读 git；空间不够时先截断分支标签 | `SessionTree.tsx` | 不为侧栏调 git；右栏有实时的分支 |
| 设置页的位置 | 新的一节 `Storage`，排在 `General` 之后，块名 `Worktrees` | `SettingsPage.tsx`、`settings/StorageSection.tsx` | 照 Claude 的 Settings > Storage；When you’re away 在 `General`（§9.6），两节都留 |
| Initialize git 的确认框焦点 | 在 `Cancel` | `InitGitDialog.tsx` | 会在你的文件夹里建仓库并提交，同删除确认框的做法 |
| Initialize git 在运行中 | 拒绝（`This session is still running. Stop it first.`） | `initGit` | 不在 Agent 写到一半时提交 |
| 没设 user.name / user.email | Initialize git 什么都不做，说明要设什么 | `initGit` | 不替你用别的名字提交；做之前检查，不留下半个仓库 |
| 第一次提交 | `git commit --allow-empty -m "Initial commit"` | `initGit` | 空文件夹也要有提交，Worktree 开关才会出现 |

## 18. 要改的文件

别的文档里加的注一律写“（2026-10-26 注：见 file-system.md §n）”；§6–§10 写“（2026-10-26 注：见 file-system-permissions.md §n）”。

| 文件 | 改什么 |
| --- | --- |
| `docs/proposals/file-system.md` | 不改（第一版已定，状态行已指向本文） |
| `docs/specs/file-system.md`、`docs/specs/file-system-permissions.md` | 本文 |
| `docs/v1/screens/fs-permissions.md`、`fs-changes.md`、`fs-rewind.md`、`fs-question.md`、`fs-worktree.md`（新） | 屏幕状态表（§13），按本文写好：原因行含 `unanalyzed`（§12）；This session 上方嵌套仓库那一行（§5.3）；Storage 排在 `General` 之后（§11.10） |
| `docs/v1/screens/README.md` | 索引加这五个表；来源一段加 `mori.workspace_status`、`mori.turn_changes`、`mori.rewind`、`workspace.status`、`snapshots.diff`、`rewind`、`rewind.undo` 的结果；`team-approvals.md` 一行的“全部允许”加注（§6.7） |
| `docs/v1/defaults.md` | 新一节“文件系统”（§17）；“平行 Agent 与 TaskBoard”一节“写入锁持有范围”一行：写 task 是 `limits.write` 不是 false 的 task（§8.7） |
| `docs/v1/fs-checks.md`（新） | 检查记录：开工前先核对 §6.1 引用的 mori-team 行为（交接后拒绝、强制填写，现在只按平行 Agent 规格核对过），结果记在这里；快照实测（FS-21）、命令语料统计（FS-55，只写数字和命令的形状）、`Full access` 在窄栏重量的宽度、跳过的测试层与未验证项 |
| `docs/v1/screens/team-blocked.md`、`team-approvals.md`、`memory-chat.md` | team-blocked：“右栏：后台改动的说明”一节作废，见 fs-changes.md（§5.1）；team-approvals：“哪些调用出卡”“切到全部允许时有挂起的卡”“本会话不再询问”按 §6.7–§6.9，后台卡带原因行，同样计时、到时 `by: 'away'`，“对话一轮结束不清掉后台卡”不变（§9）；memory-chat：Allow all 改为 Full access（§6.7） |
| `docs/app-v0.md` | 第 4 节：“v0 只看 diff，回退用 git”由内部仓库的快照与 Rewind 替代（§4、§5），“按命令前缀放行、复合命令识别等批准规则”：复合命令的拆分与写入目标的分析由 §7 做，按命令前缀放行仍不做，表中“批准”一行的“Mori 最小扩展”改为“Mori 路径闸（工作区）”；5.3 节：worktree 会话按主文件夹算项目、侧栏标出分支，归档、删除时的处理见 §11.9；5.7 节：“Ask each time / Allow all”“放行名单是一个常量，没有其他规则”见 §6，“窗口不在前台时任务栏闪烁”加提问卡（§9.9）；5.9 节：右栏改为 Changes（git 状态与 This session，§5）；第 6 节：“八件事”加第 9 件“工作区”（本文），“最小批准扩展”一段改为路径闸（§6），“会话与数据”加 `%LOCALAPPDATA%\Mori\snapshots`（测试用 `MORI_SNAPSHOTS_DIR` 改，§4.1），`MainToKernel` 加 `window_focus`（§9.1）；第 11 节：2026-10-19 的“不做规则引擎”“只做……最小批准扩展”由路径闸取代 |
| `AGENTS.md` | 仓库结构：`docs/specs/` 加本文（两个文件），`docs/v1/` 加 `fs-checks.md`，`src/kernel/` 的说明加工作区；工作约定第 4 条：“八件事”改“九件事”，第 9 件是工作区，按 `docs/specs/file-system.md`；第 6 条：文件系统的临时默认值登记在 `docs/v1/defaults.md`；测试分层第 1 条：`test:min` 的单元组加 `test:fs-unit`（四组改五组）；第 2 条任务里不跑的套件加 `fs-*`；第 3 条推送前的完整测试加各 `fs-*` 套件、`node tests/ui/v1-models-existing.mjs --id FS-115`（它同时写 MP-37、TB-46、MEM-35、MD-15 的结果，§19.3）与 `node tests/spec-coverage.mjs --spec filesystem`；常用命令加 `test:fs-unit`、`test:filesystem`，`test:min` 一行改为五组单元测试 |
| `app/package.json` | 脚本 `test:fs-unit`（`node --test --test-reporter=./tests/unit/fs-reporter.mjs "tests/unit/filesystem/*.test.mjs"`）、`test:filesystem`（§19.3）；`test:min` 在 `test:md-unit` 之后加 `npm run test:fs-unit` |
| `docs/specs/parallel-agents-taskboard.md` | §0 第 18 行“临时提问与订阅的只读实例”；§4.1 `tools` 一行与例子里的 `tools: [read]`、§4.3“角色文件只是说明和工具清单”、§4.4 工具那一行；§5.1 `mori.team { mode, tools? }`；§5.2“能不能改文件取决于它的工具配置”与 `setActiveToolsByName`；§5.5 整节（工具不变、程序收窄、`RELAY_ONLY` 在路径闸、职责工具按模式，对话与免批准工具加 `ask_user_question`）；§5.6、§8.5、附录 A 的 `ask_user`、`relay`、`create_need_user` 加选项行；§6.1 `readOnly`；§6.3 `task_create`、`agent_message` 两行与“工具在会话建立时固定”，交接单加 `options`、`recommended`（§7.2 同）；§6.4“是否只读”；§7.7 第 3 步：答复也可能来自提问卡的转发；§8.1–§8.3 的工具一列、白名单、工作卡 task 行；§9.2 写 task 的定义；§9.5 订阅只读；§10.1 两处“只读”与 `agent_message` 的参数；§11.1 Allow all、§11.2 免批准的工具（加 `memory`、`ask_user_question`，读取另归一类）、§11.3 后台卡带原因行、同样计时、你不在时按拒绝处理；§13.10 的 `teamEdited`、§13.12：后台实例改的文件列在 This session；§14.1、§14.3（`tool_call` 一行；钩子表加 `mori-approval` 的 `agent_before_settle`）、§14.6 T-T2 括号里的说明；§17.1 真实层两条；§17.2 TB-01、03、04、05、09、10、13、23、24、30、33、34、44、45、49、57（§19.4）；第 96、111 行 `<project>/.mori/agents`：worktree 会话从主文件夹读（§11.7）。各处注明对应的 §6、§8、§9、§10、§11 |
| `docs/proposals/parallel-agents-taskboard.md` | 第 88 行 `tools: [read]`、第 97 行“它能不能改文件，取决于它的工具配置”、第 116、309、352 行“只读实例”、第 222 行“（只读）”、第 237–238 行“程序据此不给它写入工具”、第 296 行“是否只读”：工具不再开关，改为收窄 `limits`（§8） |
| `docs/specs/memory.md` | §0 第 31 行“命令和 MCP 一律自动执行”：写到外面或受保护路径的命令直接拒绝（§8.10）；§2 表的 TaskBoard 一行与“批准”一行（`all` → `full`、没人能批，§6.11）；§3 第 126 行与 §9.5 第 632、639 行：先取 `projectFolder(cwd)`（§11.7）；§7.2 第 428 行、§7.6 第 504 行“含只读 task”→“含 `write: false` 的 task”；§7.6 第 500–503 行按 §8.6 的职责工具表，旁注 `ask_user_question` 与 `memory` 同为按席位给的工具（§10.1）；§7.7（第 510 行一带）：路径解析移到 `pathGate.ts`、`..notes` 这种名字改算在里面（§6.3），最后一句加“命令的写入目标改由路径闸分析，MCP 仍不分析”（§7）；§9.6 第 654 行（`all` → `full`）与第 672–674 行（写到外面的命令直接拒绝）；附录 A.1：text 块第二行之后加 §14 的 `.work` 一行（块里只放原文，MEM-01 按 `specBlock('### A.1')` 逐字读），第二句按模式三种（§6.16），注写在块外；MEM-11 去掉“写了 `tools` 的对话角色”，MEM-20 加“写到外面的命令直接被拒绝、不出卡”，MEM-31“含只读 task”、它的不合格角色文件改用 `seats: [nowhere]`（问题行随之变，§19.4），MEM-11 的单元测试（`core-team.test.mjs:58-73`）按 §19.4 改期望，MEM-28 加注：设置页的分节由三节变为五节，多 `General`、`Storage`（它的 App 测试 `mem-app-settings.mjs:713-715` 断言分节，§19.4；2026-10-26 注：见 file-system-permissions.md §9.6、file-system.md §11.10）；§14.4 `tb-app-roles.mjs`（TB-09）一行的 `tools: [read]` 集合去掉 |
| `docs/specs/model-providers.md` | 第 131 行 `projectZones` 的键与 §4.3 的 `<project>/.mori/models.json`：项目路径先取 `projectFolder`（§11.7）；`mori.pick` 一处：恢复对话、Undo 回到原来的分支之后在新的当前分支末尾再记一条（§5.8，写规格时定的第 7 条） |
| `docs/v0/ui-strings.md` | 第 47 行改写（Full access 代替 Allow all，说明它不是 Claude 的 Bypass permissions、也不是 Codex 的 Full access）；第 187–198、388、453–454 行的 Allow all 换掉；第 220 行 `This session’s changes` 改 `Changes`（读屏名 `Toggle changes` 不变），第 221 行去掉 `Only edits and writes are listed. Files changed by commands aren’t included.`；术语表加：Changes、This session、Rewind 与菜单四项、No code restore、Undo、Overwrite / Skip these files、Git is required to …（track changes and rewind、create a worktree、initialize a repository、restore this session’s worktree、clean up worktrees）、Not a git repository、Staged / Unstaged / Untracked / Conflicts、Up to date、No uncommitted changes、Turn <n>、`Changes inside nested repositories aren’t tracked: …`；Full access 的确认框与悬停说明、原因行五种、按目录放行的按钮与小字、`Writes to <目录>`、三种按工具名放行的小字；`Couldn’t analyze this command: <reason>`、`(paths from input)`、`(unrecognized parameters of <cmdlet>)`；你不在 = away（When you’re away、You’re away · …）、Decided while you were away；提问卡的 Recommended、Other、Submit、`Denied · You declined to answer`、`Waiting for your answer`、`Ask · <headers>`；Worktree、Initialize git… / Initialize git / Initializing…、Creating worktree…、Checking its worktree…、Clean up worktrees… / Clean up / Cleaning up…、General、Storage；`Couldn’t create the worktree: …`、`Couldn’t initialize git: …`、`Couldn’t load worktrees: …`、`Couldn’t delete <branch>: …`（原文见屏幕表）；`Git 2.32 or newer is required to track changes and rewind (found <version>).`、`Taking a snapshot…`、`This repository sets core.worktree, …`、`The folder <sub> isn’t committed yet, …`、`The worktree folder <path> exists but isn’t registered with git. …`、`Restoring the worktree timed out after 120 seconds.`；“会话引用的内容”一节：Turn N 与右栏的 `Turn <n>` 用同一个计数，`[Mori]` 投递接到前一轮里（§5.3） |
| `docs/v0/screens/session-refs.md` | 第 28、65、80 行一带的 Turn N：与右栏 This session 的 `Turn <n>` 同一个计数，`mori.wake` 指向的投递不另起一轮、它的 `User:` 几行接到前一轮里（§5.3）（2026-10-27 注：负责人不在时按推荐定，待复核） |
| `docs/v1/screens/model-chat.md` | “准备中”一节加注：选完模型之后、`agent_start` 之前，用户会话等运行开始的快照时阶段行显示 `Taking a snapshot… · <秒数>`（§4.5、§13，fs-changes.md） |
| `docs/v0/screens/approval.md` | “哪些调用要批准”、`mori.tool_gate` 的值、`approval.setMode`、警示行 “This file is outside the working directory”、Allow all 的工具卡标签、权限菜单与确认框：见 §6 与 fs-permissions.md；“拒绝的固定写法”表加你不在、到时一行，“选项”后注明卡上的倒计时（§9.4） |
| `docs/v0/screens/changes.md` | “改动列表”一节与反例第 1 条：见 fs-changes.md；文件阅读器部分不变（重读依据见 §5.1） |
| `docs/v0/screens/sessions.md` | 第 155 行“Mori 没有 worktree，不涉及”改写为 §11.9 的归档、删除、重新检出；“项目 → 会话树”与会话行：按 `projectFolder(cwd)` 分组、分支标签（§11.7）；删除确认框、“新建或打开失败”：worktree 的一句与恢复失败的原文（§11.9）；“项目信任”的“本次回答过”按主文件夹（§11.7） |
| `docs/v0/screens/settings.md` | “外框”加两节 `General`（§9.6）、`Storage`（§11.10） |
| `docs/v0/screens/extension-ui.md` | 询问卡你不在时按取消处理、倒计时一行，“任务栏不闪”不变（§9）；询问卡与提问卡按到达顺序排（§10.4） |
| `docs/v0/screens/tool-cards.md`、`chat.md`、`models.md`、`f8.md`、`docs/v0/composer-pickers.md` | Allow all 改为 Full access，窄栏按它重量（§6.7、§6.14）；tool-cards 加 `Ask · <headers>` 与状态（§10）；chat.md“输入框下面一行”与 models.md“窄栏”：还没发消息时权限按钮后面是 Worktree 开关或 Initialize git…，≤ 460px 只剩图标（§11.4）；composer-pickers 第 23–24、71–72、112、183、378、429、658、672 行一带，量出的新宽度写进检查记录 |
| `docs/v0/defaults.md` | 第 24 行扩展询问的超时：另有你不在的计时（§9）；第 40 行拒绝时的工具结果：程序拒绝的开头见 §12；第 43 行右栏自动打开：按第一次收到 `mori.turn_changes`（§5.1）；第 63 行 Allow all 的字色用在 Full access 上（§6.7） |
| `docs/v0/m2-checks.md` | 不改（检查记录）；新结果写进 `docs/v1/fs-checks.md` |
| `app/src/` | §2 表中的文件 |
| `app/tests/` | §19 |

## 19. 验收

### 19.1 测试分层

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 单元 | `tests/unit/filesystem/*.test.mjs`（`node --test`，经 esbuild 打包内核模块；报告器 `tests/unit/fs-reporter.mjs` 写 `fs-unit.json`，用严格模式：跳过的、标为待办的测试与套件自己的失败都记为失败，同 `md-reporter.mjs`） | 纯函数与模块：git 的运行（替身进程经注入的 `spawn` 与找 git 的候选，§3.2、§3.3；以及真实 git）、`repoInfo`、porcelain v2、`timeline.ts` 的段与轮、内部仓库与快照（真实 git，临时目录里 synthetic 的仓库）、Rewind 的计划与恢复；`pathGate.ts`（与 pi 的解析逐个比较、联接、注入计数的 `lstat` / `realpath`）、判断顺序；`scan-bash.test.mjs`、`scan-powershell.test.mjs`（§7.9 的两张表）、`work.test.mjs`；`limits.ts`；`away.ts`（注入的时钟）、`askQuestion.ts`；`worktree.test.mjs`（真实 git） |
| 合成端点 | `tests/fake-endpoint/`（synthetic） | 用现有的关键词与脚本模式驱动 bash、edit、write、`ask_user_question` 与后台实例的调用；脚本里的 `read_only` 改为 `limits`（§19.4）；附录 A 各段的第一句不变，所以认会话种类的 `SEGMENT_SENTENCES` 不变 |
| App | `tests/ui/` 下按屏幕与模块分的八个套件：`fs-app-changes.mjs`（FS-05、06、08–14、20、22、23、26）、`fs-app-rewind.mjs`（FS-15–19、24、25）、`fs-app-gate.mjs`（FS-34–39）、`fs-app-work.mjs`（FS-53、54）、`fs-app-team.mjs`（FS-57、59–62、65、66、68；2026-10-28 加 FS-116、FS-118）、`fs-app-away.mjs`（FS-69–81）、`fs-app-question.mjs`（FS-83、84、86–90）、`fs-app-worktree.mjs`（FS-98–107、109–112） | Electron + 合成端点，逐条验收；`MORI_USER_DATA` 与 `MORI_SNAPSHOTS_DIR` 指到测试目录；只有测你不在的套件（`fs-app-away.mjs`，FS-69–81）设很短的 `MORI_AWAY_TIMEOUT_MS`，其余 fs-app 套件启动后先 `away.set { timeout: 'never' }`（同 §19.4）；测试项目在临时目录里（是不是 git 仓库按条目）；FS-13、15、23、98、106、107 里“没装 git”的步骤另起一个 App，`env: { MORI_GIT_PATH: <临时目录里不存在的路径> }`（§3.2 第 0 步），开发机装着 Git for Windows 也能得到 `missing` |
| 回放 | `tests/ui/fs-replay.mjs`，fixture 在 `tests/fixtures/filesystem/`（`harness/main.jsx` 加载这个目录） | `fs-real.mjs` 从真实会话录下（`work-scratch.json`：FS-54；`full-outside.json`：FS-36，FS-114 的 Full access 写到外面；`away-reminder.json`：FS-78，FS-114 的自动拒绝与提醒）：批准卡的原因行、`Denied`、提醒不显示；回放桥的 `workspace.status` 用标明 synthetic 的合成结果（§19.4）；`git` 为 `old` 的界面（FS-13）在这一层测：fs-replay 让合成的 `workspace.status` 返回 `git: { state: 'old', version: '2.31.0' }`，断言 `Git 2.32 or newer …` 一行与 `data-state="old"` |
| 真实 | `tests/ui/fs-real.mjs --source <你的数据目录> [--repo <第二个仓库>]`（各部分共用） | FS-21、FS-40、FS-54、FS-55、FS-67、FS-82、FS-93、FS-113、FS-114；只断言程序保证的事，模型写了什么写进 note |

**与 AGENTS.md“测试分层”的关系**：每个任务只跑 `npm run test:min`，它加上 `test:fs-unit`（§18）；现有的 `test:min` 本机实测 86 秒，留给 `test:fs-unit` 的约 30 秒，
所以用真实 git 的单元测试（FS-03、FS-06、FS-07、FS-08、FS-20、FS-97 等）合计不超过 20 秒。为此快照与 worktree 的上限都是参数，默认为 §17 的值、测试传很小的值：
`snapshots.ts` 的单个文件上限（10 MB）、新文件数上限（20000）、分批条数（2000）、每个 git 进程的超时（120 秒）、保留的轮数（100），`createWorktree` 与 `initGit` 的超时（120 秒）
（§4.4、§4.7、§11.5.3、§11.11）。用例按“比注入的上限多一个”写，不建 2 万个文件、不拍 101 轮（起草时量过：建 2 万个文件 57 秒、`add -A` 58 秒，10 个文件上 101 轮 24 秒）。
实现时把 `test:fs-unit` 与 `test:min` 实测的总时长写进 `docs/v1/fs-checks.md`（前者 ≤ 20 秒，后者 ≤ 2 分钟）。App、回放、真实、`spec-coverage` 与 `npm run test:filesystem` 不在任务里跑，交付说明列为未验证，留到负责人要求推送前的完整测试；
录 fixture 与真实模型走查要做（§14 改了模型看到的文字），由你用数据目录跑 `fs-real.mjs`。
（2026-10-27 注：收尾检查先落地时，`test:min` 里已有 `test:fc-unit`（≤ 10 秒），先连同它重量一次 `test:min` 再用这里的额度；合起来超过 2 分钟时停下报告，见 [finish-check.md](finish-check.md) §11）

### 19.2 验收条目

每条测试的名字以条目编号开头。

| 编号 | 条目 | 通过条件 | 层 |
| --- | --- | --- | --- |
| FS-01 | 找 git | 候选与 `spawn` 注入替身（§3.2）：PATH 里的 `git.exe` 优先于 Program Files；都没有为 `missing`；`--version` 失败为 `missing`；2.31 为 `old`、2.32 为 `ok`；`MORI_GIT_PATH` 有值时只试它，不存在为 `missing`；`missing` 时下一次 `workspace.status` 再找，放上一个可用的 git 后变为 `ok`；`ok` 之后不再找 | 单元 |
| FS-02 | 运行 git | 子进程环境没有任何 `GIT_*`（父进程设了 `GIT_DIR`、`GIT_INDEX_FILE`、`Git_Work_Tree` 也没有），有 `LC_ALL=C`；内部仓库的调用带固定的 `--git-dir`、`--work-tree`、5 个 `-c`、`GIT_CONFIG_NOSYSTEM`、`GIT_CONFIG_GLOBAL`，调用前 `<快照目录>\gitconfig` 不在时被写出、已有的不被覆盖；用户仓库的调用不带这些 `-c`；`process.env` 前后相同；超时与输出上限结束进程并标记；同一个键的两个调用不重叠、不同键并行 | 单元 |
| FS-03 | 认仓库 | 真实的临时仓库：仓库根、子文件夹（`toplevel` 为仓库根）、链接出去的 worktree（`isWorktree` 为真、`commonDir` 是主检出的 `.git`）、没有提交、不是仓库（`repo: null`）；替身 git（注入的 `spawn`，§3.3）对 `rev-parse` 返回退出码 128 与 stderr `fatal: detected dubious ownership in repository at '<cwd>'` 时，`repoInfo` 是错误、原文为去掉 `fatal: ` 的那一行，而不是“不是仓库” | 单元 |
| FS-04 | git 状态的解析 | porcelain v2 的 `1`、`2`（含 NUL 分隔的原路径）、`u`、`?` 行；同一文件既暂存又未暂存为两条；`(initial)`、`(detached)`、有上游没有 `branch.ab`；500 条上限与 `total`；输出上限截断到完整的条；超时为 `error`；路径相对仓库根（在子文件夹里也是） | 单元 |
| FS-05 | 刷新时机 | §3.5 每个时机各发生一次读；连续 5 个 bash 调用在 500 毫秒内只读一次；读的过程中再请求只多读一次，命令的结果晚于它发出的时刻；同路径的两个打开的会话都收到 `mori.workspace_status`；`kernel/git.ts`、`workspace.ts`、`snapshots.ts` 里没有 `fs.watch`、`watchFile`、`setInterval` | 单元、App |
| FS-06 | 内部仓库 | 单元用真实 git：位置按 `MORI_SNAPSHOTS_DIR`、编码同 `projectDirName`；工作路径里没有新的 `.git`、你的仓库 `git for-each-ref` 不多任何 ref、index 与 `git status` 前后相同；`mori.json` 归属冲突时 `off` 与原文；`info/attributes` 生效：`.gitattributes` 写 `* text=auto eol=lf` 时 CRLF 文件 Rewind 后逐字节相同；隔离的配置生效：测试用的全局配置设 `core.autocrlf=true`、`filter.lfs.required=true`（没有 lfs 程序）时快照照常、恢复逐字节相同；留下的 `index.lock` 在第一个作业前被删掉；（单元：注入的 `spawn` 只对用户仓库的 `rev-parse` 返回 FS-03 的 dubious ownership，其余交给真实 git）`repoInfo` 报错时这一张快照失败、`snapshots.error` 为原文；这一句 App 层不测（Windows 上让目录归别的账户要管理员权限，界面显示 `error` 由 FS-13“读失败的原文”覆盖） | 单元、App |
| FS-07 | 排除与 git status 一致 | 用真实 git：仓库根、子文件夹（仓库根 `.gitignore` 忽略的 `node_modules` 在子文件夹里也不进快照）、`info/exclude`、全局 `core.excludesFile` 的规则都生效；被 `add -f` 跟踪又匹配忽略的文件进快照；`.work/`、`.mori/worktrees/` 总被排除；非仓库的五个默认目录在任何一层被排除；名字里有 `[`、`]`、开头有 `#`、`!` 的被忽略文件按字面排除（`*`、`?` 在 Windows 的文件名里不能有）；一个目录眼下全被忽略、之后有了不被忽略的文件时，下一张快照收进那个文件；整个工作路径被忽略时快照为空 | 单元 |
| FS-08 | 上限与暂停 | 单元按 §19.1 注入上限（单个文件 1 KB、新文件 20 个、分批 5 条）：比单个文件上限大的未跟踪新文件不进快照、在 `skipped` 里；已被你跟踪的同样大的文件照样进；21 个新文件时 `paused` 与原文、不拍、不对 N 做 `stat`；`ls-files --others` 的输出被截断（把输出上限调小）时同样 `paused`、不 `stat`；加 `.gitignore` 后下一个快照点恢复，暂停期间的改动不记；新文件多于分批条数时分批加入，某一批超时（超时调小）为 `error`（`a snapshot step took longer than 2 minutes`）、已加的批次留在内部仓库的 index、下一个快照点续做完成，连续 3 张超时后 `paused` 与原文；其他失败为 `error`，下一次照常。App 用真实大小（11 MB 的文件、20001 个空文件，只数不加；App 不在 `test:min` 里）看 This session 的两种说明 | 单元、App |
| FS-09 | 时间线与归属 | 单元为 `timeline.ts` 的纯函数：§4.5 的例子逐行；空闲段不记；树没变不建提交；一次运行里插话的消息只拿到它之后开始的段；程序投递开始的运行归你最近的消息；`messageType: 'custom'` 开始、中途有插话的运行：插话之前的段归你之前最近的消息，插话的消息没有 `run`；运行开始时起始消息还没写下、恰有实例结束时，那一段仍归起始消息（叶子已被别的条目移动过也一样）；`before_agent_start` 之后没开始运行的不留在 `active`；同一工作路径的作业不重叠（两个会话同时开始时快照依次拍） | 单元、App |
| FS-10 | 运行记录 | 你的消息开始的运行写一条 `run`，`round` 是这条消息、`start` 是运行开始前的快照（运行里第一次写文件之前的内容）；`[Mori]` 投递、扩展发起的运行不写；运行进行中开始快照有 `run/` 下的 ref，写下 `run` 后它没了、轮下有 ref；运行开始的快照做完之前按停止，这次没有 `run`、快照的 git 进程被结束、没有结束快照、`active` 里没有它，下一次运行的快照照常（没有留下 `index.lock`）；这时关闭会话同样立刻结束那个 git 进程（`release` 先通知，§4.5），不等它跑完；排队、插话的消息没有 `run`；运行开始的快照期间阶段行为 `Taking a snapshot… · <秒数>`（`data-kind="snapshot"`），`agent_start` 之后换成平常的阶段，实例的运行不改阶段行 | App |
| FS-11 | 一轮的改动记录 | bash 命令改的、写的、删的文件都在（`echo x > a.txt`、`rm b.txt`、新建）；A/M/D 与行数；二进制为 null；嵌套仓库与符号链接不列；501 个文件的段 `files` 500 条、`total` 501；协作模式下 task 改的文件记进用户会话、`agents` 有 `<角色> (T1)`；两个用户会话同时运行时两边都 `overlap: true`；在 `<R>` 与 `<R>/app` 开的两个会话同时运行时两边的记录也都 `overlap: true`；条目与事件相同，重新打开会话后 This session 不变 | 单元、App |
| FS-12 | This session | fs-changes.md 的 This session 各状态：按轮、新的在上、`Turn <n> · <第一行>`、文件行（字母、路径、行数、Agent、Open）、点开 diff（`snapshots.diff`，git 的 patch 在 `Diff.tsx` 里正确显示）、二进制与没有差别、重叠与没列全的说明、快照暂停与大文件的说明、`No changes yet.`；阅读器在新的一段记到打开的文件时重读；这个会话第一次收到 `mori.turn_changes`（`changes`）时右栏自动打开到 Changes，你手动关过之后再收到也不打开；只恢复代码之后那些轮照样列出，恢复对话之后丢掉的轮不再列出；协作模式下（有 `[Mori]` 投递）组标题的 `Turn <n>` 与会话引用预览的 `Turn N`、芯片的 `turns a–b` 指同一条消息 | App |
| FS-13 | git 状态界面 | App：fs-changes.md 的三种文件夹状态（没装 git 用 `MORI_GIT_PATH`，§19.1）；分支行各写法；四个分组；点文件打开阅读器；Refresh；`No uncommitted changes`；超过 500 条的说明；读失败的原文；没装 git 时没有 `+N −M` 与 Rewind。回放：`old`（fs-replay 合成 `version: '2.31.0'`）只有 `Git 2.32 or newer is required to track changes and rewind (found 2.31.0).` 一行、`data-state="old"`，没有 This session | App、回放 |
| FS-14 | 命令和后台 Agent 改的都在 | 合成端点让对话 Agent 用 bash 改文件：This session 列出它；协作模式下 task 用 edit 和 bash 改文件：列出、标出 Agent；不再有 `Only edits and writes…` 与 `Changes made by team tasks aren’t listed here.`（替代 TB-57） | App |
| FS-15 | Rewind 菜单 | fs-rewind.md 的菜单四种情况；排队、插话的消息有 `No code restore`；运行中（含只有后台实例在运行、有待判断的消息）按钮不可点、悬停 `Still running`；没装 git（`MORI_GIT_PATH`）没有 Rewind；`[Mori]` 消息没有 Rewind；键盘：Tab 到按钮、Enter 打开、方向键、Esc 关掉焦点回来 | App |
| FS-16 | 计划与冲突 | 文件集合是这一轮起的并集（不含别的会话独自改的文件）；最近一张快照之后你在编辑器里改过的文件列为 `changed`；与另一个用户会话同时运行时改的列为 `overlap`，在 `<R>/app` 里开的会话同时运行时改的文件在 `<R>` 的会话里 Rewind 时同样列为 `overlap`；Overwrite 全部恢复；Skip these files 冲突的保持原样；Cancel 什么都不改；两次调用之间又多了冲突时重新列出、不恢复 | 单元、App |
| FS-17 | 恢复代码 | 改过的、删掉的文件回到这条消息之前的内容；这条消息之后新建的文件被删；你自己新建、没有被记下的文件不动（不 `git clean`）；你的 index、HEAD、分支不变；一个文件被锁时其余照常恢复、它进 `failed`；P、Q 两张快照与 ref 存在；P→Q 这一段里恢复的文件没有记给任何会话；同一文件夹的另一个会话在 P、Q 之间改的别的文件记给那个会话；保险快照失败时什么都不改、原文正确；第 1 轮删 `README.md`、第 2 轮新建 `Readme.md`，Rewind 到第 1 轮之前后 `README.md` 存在且内容为原来的，`Readme.md` 不在（Undo 同样先删再恢复） | 单元、App |
| FS-18 | 恢复对话 | `navigateTree` 后当前分支在这条消息之前，对话流按新分支显示；这条消息的文字和引用芯片回到输入框（草稿之前）；第一条消息上恢复对话后对话为空；这条消息恰是叶子（后面什么都没有）时按 §5.8 处理；TaskBoard 不变；有未关闭的需求在这条消息之后登记时两个恢复对话的选项不可选、原文正确，`Restore code` 仍可用；后台进程同样拒绝 | App |
| FS-19 | Undo | 恢复了代码的 Rewind 之后有 Undo；Undo 把文件回到 Rewind 之前，恢复过对话的同时回到原来的分支；Rewind 之后你改过的文件进冲突；发一条消息、再 Rewind 一次之后没有 Undo；只恢复对话的没有 Undo；Undo 之后没有 Redo | App |
| FS-20 | 保留与整理 | 单元把保留的轮数注入为 3（§19.1）：第 4 轮写下后最早一轮的 ref 被删、记录还在，它的 diff 与 Rewind 到它报整理原文；App 不建 101 轮：整理原文在 This session 与 Rewind 里的显示，用 `git update-ref -d` 手工删掉内部仓库里一轮的 ref 做出；删除会话后它的 ref 没了；没有别的会话时内部仓库目录被删，有时 `prune` 后别的会话的快照仍可 Rewind；删掉文件夹上最后一个会话后，在同一次后台进程里新建会话、改一个文件：`run` 记录的 `start`、`end` 都是内部仓库里存在的提交（`git cat-file -e`），This session 正常列出；归档不动快照 | 单元、App |
| FS-21 | 实测与资源 | `fs-real.mjs` 记一条 `FS-21 …` 检查：在 Mori 仓库（`appRoot/..`）与 `--repo` 给的仓库上各拍三张快照，全部成功即通过；第一张与之后每张的耗时、内部仓库大小写进 detail；没给 `--repo` 时只量 Mori 仓库，detail 写明；协作模式下的量法与 FS-67 共用一次运行，`refs/mori` 下的提交数与快照总耗时写进 detail；数字抄进 `docs/v1/fs-checks.md` | 真实 |
| FS-22 | 退出与崩溃 | 有序退出时被中止的运行的结束快照做完、记录写下；强行结束后台进程后重启：没有报错、上一次没写的记录不存在、陈旧的锁被清掉、新的运行照常拍快照 | App |
| FS-23 | 顶栏 `+N −M` | fs-changes.md 顶栏各状态：数字等于当前分支上 `changes` 记录的 `added`、`removed` 之和（二进制不计）；新的一段记进来随即更新；只恢复代码不变、恢复对话后按新分支重算；为 0、没装 git（`MORI_GIT_PATH`）、这一栏不宽于 600 px 时不显示，git 太低时不显示在回放层看（同 FS-13 的合成结果）；点它打开右栏到 Changes（打开的是阅读器时切回）；读屏名单复数正确；`Toggle changes` 悬停为 `Changes` | App、回放 |
| FS-24 | 进行中与动作记录 | Rewind、Undo 进行中：对话流末尾 `Rewinding…` / `Undoing…`，发送按钮不可用；这时 `session.prompt` 被拒绝、原文 `This session is rewinding. Send your message when it’s done.`；再发 `rewind` 被拒绝、原文 `This session is already rewinding.`；动作记录有 `Refresh changes`、`Rewind: <菜单项>`、`Rewind conflicts: Overwrite` / `Skip these files` / `Cancel`、`Undo rewind` | 单元、App |
| FS-25 | Rewind 后再记一次 `mori.pick` | 会话：在范围 A 下发你的消息 M1（让它改一个文件，有 code restore），M1 这一轮之后把范围改成 B（`mori.pick` B 写在 M1 之后），再发 M2（同样改一个文件）。分别在两个这样的会话里对 M1 做 Restore conversation 和 Restore code and conversation：新的当前分支末尾、`mori.rewind` 之前有一条值为 B 的 `mori.pick`；关闭并重新打开会话，范围是 B；Restore code and conversation 那个会话 Undo 回到原来的分支后，末尾同样有一条值为 B 的 `mori.pick`；对 M2 只做 Restore code 时不写 `mori.pick` | App |
| FS-26 | 嵌套 git 仓库的说明 | 单元用真实 git：工作路径里有两个嵌套的 git 仓库（一个子模块，一个不是子模块、已有提交的独立仓库）：它们里面文件的改动不在 This session，Rewind 不恢复；`WorkspaceStatus.snapshots.nested` 是这两个路径（相对工作路径）；This session 上方一行 `Changes inside nested repositories aren’t tracked: <路径>, <路径>`；去掉嵌套仓库后下一张快照起没有这一行；21 个时列出 20 个并接 ` and 1 more`；工作路径里再加一个还没有提交的嵌套仓库时，这一张快照失败，`snapshots.error` 为 git 原文（`'<dir>/' does not have a commit checked out`），This session 显示 `Couldn’t take a snapshot: <原文>`；给它提交之后下一张恢复 | 单元、App |
| FS-27 | 路径解析与 pi 一致 | `pathGate.resolveToCwd` 与 pi 的 `dist/core/tools/path-utils.js` `resolveToCwd`（测试按文件路径 import）对同一组输入结果相同：相对、`..`、`@` 前缀、`/c/…`、`/mnt/d/…`、`/cygdrive/c/…`、`~`、`~/`、`~\`、`file://`、特殊空格、`\rooted`、`C:rel`、UNC；`insideDir` 与 pi 的 `getCwdRelativePath` 对“在不在里面”的判断相同（含 `..notes` 这种名字算在里面、`..` 与 `..\x` 算在外面）；MEM-13 的断言改 import 后照常通过 | 单元 |
| FS-28 | 四种归类与名单 | §6.4、§6.5 的每一行各有用例：`inside`、`work`（含 `.work/x/.git/config`）、名单里每个目录与文件（任一段、大小写不同、末尾带 `.` 或空格、带流名）、`.config/git`；`remove` 为真的 `.` 与 `..` 归 `protected`，`remove` 为假的 `.`（`cp a.txt .`）归 `inside`、`..` 归 `outside`；前缀相同的兄弟目录算外面；外面路径含 `.gitconfig` 归 `protected`；工作路径在 `<主文件夹>/.mori/worktrees/x` 时，它自己的 `src/a.ts` 归 `inside`、主文件夹的 `src/a.ts` 归 `outside`、主文件夹的 `.mori/agents/a.md` 与别的 worktree 下的文件归 `protected`；`leaves` 的 `dir` 在工作路径里（`cd src`、`cd .git`）时丢掉 | 单元 |
| FS-29 | 链接 | 临时目录里建目录联接（`fs.symlinkSync(…, 'junction')`，不要管理员权限）：里面指向外面的联接下的写入归 `outside`、请求的 `path` 是真实路径；`.work` 是指向外面的联接时归 `outside`；外面指向里面的联接下的写入归 `outside`；悬空的链接、注入的 `lstat` 报 `EPERM` 时归 `outside` 并记日志；词法上在外面的目标（含 UNC）不调用文件系统（注入计数的 `lstat` / `realpath`，次数为 0）；一个调用里几个目标只取一次工作路径的真实路径；`cd <里面指向外面的联接> && npm i` 记作 `leaves`（§7 对每一次换目录都报告），`cd src && npm i` 被丢掉 | 单元 |
| FS-30 | 判断顺序 | §6.1 与 §6.7 的表逐格：每种调用 × 每类目标 × 两种模式 × 是否按工具名放行 × 是否按目录放行 × `canAsk`，得到的结论与 `gate` 值符合表；停止中只有 `duty`、`read` 放行，写 `.work` 与其余一律 `Rejected: the user stopped the run.`；`commandScan` 抛错时记日志、按 `unresolved` 出卡，不把异常交给 pi （2026-10-27 注：收尾检查落地后 `duty` 含 `finish`：第 1 步放行、停止中也放行，见 [finish-check.md](finish-check.md) §11） | 单元 |
| FS-31 | 按工具名放行 | Ask each time 下 scope `inside` 的卡选 Allow for this session：这次放行，同名 scope `inside` 的挂起请求在所有实例里一并放行，之后不问；同名但写到外面的调用仍出卡；对 scope `outside` 的请求答 `allowSession` 命令失败；Forget 后又问（TB-34 的第 5 条改写） | 单元 |
| FS-32 | 按目录放行 | 写 `D:\out\a\b.log`（测试用临时目录）的卡有 `allowDirs: [<…\a>]`；命令 `cp x ../bk/` 的 `allowDirs` 是 `../bk` 解析出的目录本身，`cp a ../b` 的是 `..` 解析出的目录（`into` 为假，宽一级）；`cp -t ../d a` 放行 `../d`；选它后同目录的下一个写入不出卡（`gate: 'dir'`），子目录里的仍出卡；两个目标、一个被覆盖时仍出卡；挂起的、全部被覆盖的请求一并放行（`by: 'dir'`）；有 `unresolved` / `leaves` / `protected` 时 `allowDirs` 为空、答 `allowDir` 失败（`This request can’t be allowed by folder.`）；写 `D:\x.log` 这种上一级是盘符根的为空；Full access 下同样生效；Ask each time 下 `cp a.txt ../out/ && rm -rf src` 在 `../out` 被放行后仍出卡，卡的 `scope` 为 `inside`、没有 `targets` 与 `allowDirs`，只写外面的 `cp a.txt ../out/` 不出卡，Full access 下两者都按目录放行（2026-10-27 注：负责人定）；Forget 目录后又问；`approval.forget` 两者都给或都不给时失败（`Give either toolName or dir.`） | 单元 |
| FS-33 | 切到 Full access | 对话与两个实例各挂一张卡（scope `inside` 的命令、scope `outside` 的写入、scope `protected` 的编辑）：`setMode('full')` 后只有 `inside` 那张按 `by: 'full'` 结束，另两张还挂着；切回 `ask` 不结束任何请求；之后新建的实例从 `full` 开始 | 单元 |
| FS-34 | 没人能批 | `canAsk: false` 的 policy：写到外面、受保护路径的调用立即按 §6.15 的原文拒绝，不发 `mori.approval_request`、不调 `onRequest`；工作路径里的命令、MCP 放行；增强会话里命令写到工作路径外时被拒绝、工具结果是这段原文、没有卡（MEM-20 改写） | 单元、App |
| FS-35 | 预告与更正 | 对常见调用（读、`.work` 写、里面写、外面写、命令、MCP）预告的 `gate` 与处理器相同；处理器结论与预告不同时（例如两次之间切了模式）发一次更正；界面上预告 `full`、随后收到批准请求的工具卡是 `Waiting for your approval` 且没有放行标签（这一句在 App 里测） | 单元、App |
| FS-36 | 卡片的原因行 | 相对路径 `..\notes.md` 和绝对路径写到外面的卡显示 `Writes outside the working directory: <真实路径>`；`../x` 解析后在里面（`a/../b.md`）的卡没有原因行（界面不再自己猜）；写 `.git/config` 显示 `Protected path:` 且没有第二个按钮、Alt+2 不起作用；命令写 `$OUT/a.log` 显示 `Writes to a path Mori can’t resolve:`；`cd .. && npm i` 显示 `Runs outside the working directory:`；分析不了的命令（`echo "abc`）显示 `Couldn’t analyze this command: unclosed quote`、没有第二个按钮；超过 5 个目标显示 `and {n} more`；后台卡同样显示；第二个按钮与小字逐字照 §6.13 的表：scope `inside` 的命令、`edit`、`write`、MCP 各一例；`allowDirs` 一个时为 `Allow writes to <目录> for this session` 和它的小字，两个时为 `Allow writes to these folders for this session` 和 `You won’t be asked again in this session for writes directly in: <目录>, <目录>.`；界面重新载入后从 `LiveSnapshot` 接上，原因行照旧 | App、回放 |
| FS-37 | 权限按钮与菜单 | 按钮 `Ask each time ▾` / `Full access ▾`（警示色，读屏名 `Permission mode: Full access`，悬停第二行是 Full access 的说明）；菜单两项；选 Full access 弹确认框，原文照 §6.13，焦点在 Cancel，Esc 取消；确认后挂起的里面的卡消失、工具卡标 `Full access`，写到外面的卡还在；“Allowed for this session:”列出工具名与 `Writes to <目录>`，各自 Forget；新会话从 Ask each time 开始；F8 报告与操作记录写 `Full access`、`Allow writes to folders for this session`、`Forget “Allow for this session”: writes to <目录>` | App |
| FS-38 | 工具卡与 Denied | 按目录放行的调用标 `Allowed for this session`，Full access 下标 `Full access`，读取与 `.work` 写入没有标签；不出卡的程序拒绝（§8 的收窄、§6.11，以及 mori-team、mori-memory 先于路径闸的拒绝，§12 表的最后一行（2026-10-27 注：负责人定））在实时与从会话记录载入（重新打开会话）时都显示 `Denied · <原文>`，预告时标上的放行标签去掉 | App |
| FS-39 | 身份句 | `identityText('ask')` 的第二句与记忆规格附录 A.1 的第二句逐字相同；`full`、`none` 的第二句与 §14 逐字相同；切到 Full access 后下一次运行的请求里身份段是 Full access 那一句（这次运行中途切换不改这次的），增强会话的是没人能批那一句 | 单元、App |
| FS-40 | 真实模型 | 真实模型在 Full access 下：改工作路径里的文件不出卡；让它把输出写到 `..` 下出卡，原因行是那个路径，拒绝后它不重复这个调用；在 Ask each time 下改工作路径里的文件照旧出卡 | 真实 |
| FS-41 | 目标上限 | 命令有 101 个可解析的写入目标时只解析前 100 个；第 101 个起记作理由为 `unresolved` 的目标，请求的 scope 为 `outside`、`allowDirs` 为空（卡上的 `and {n} more` 在 FS-36 里） | 单元 |
| FS-42 | bash 的切分与结构 | §7.9 的 B1–B13、B34、B46–B61、B89 逐行与期望相同 | 单元 |
| FS-43 | bash 的写法 | B14–B33、B118 逐行相同（含“入”）；§7.5 Git Bash 表的每个命令、每个带值选项与“只用 `=`”的长选项至少一行；“落进目录”的每种情形至少一行，`cp a ../b` 的 `into` 为 false | 单元 |
| FS-44 | bash 的目标解析与看不出来的目标 | B34–B45（含 B42a–B42c）、B85、B91 逐行相同；§7.6 表里 bash 一列的每种写法至少一行 | 单元 |
| FS-45 | PowerShell 的切分、结构与写法 | S1–S21、S37–S46、S55–S60 逐行相同（含“入”）；§7.5 PowerShell 表的每个 cmdlet、每个别名（含只有 5.1 的 `sc`）、每个目标参数与位置至少一行 | 单元 |
| FS-46 | PowerShell 的目标解析与看不出来的目标 | S22–S27（含 S24a）逐行相同；§7.6 表里 PowerShell 一列的每种写法至少一行 | 单元 |
| FS-47 | 前缀、包装、嵌套与 eval | B62–B85、B42a–B42c、S24a、S47–S51 逐行相同；§7.4 三张表的每一行至少一行 | 单元 |
| FS-48 | 换目录与只读命令 | B92–B114（含 B105a、B105b）、S28–S36 逐行相同；§7.7 只读名单的每个名字各跑一次 `cd .. && <名字>`（PowerShell 为 `cd ..; <名字>`）都没有 leave，名单外的 `npm`、`make`、`./x.sh`、`git commit`、`xxd a b` 与带条件的反例（`find . -delete`、`sort -o x`、`tree -o x`、`uniq a b`、`git branch new`、`git config a b`、`git log --output=x`）都有 | 单元 |
| FS-49 | 解析失败、上限与纯函数 | B76–B78、B80–B84、B86–B88、B115、B116、S47、S50、S52–S54、S58–S60 逐行相同；§7.8 表的每个 reason 至少一行；B117 去重；同一输入在改过 `process.env.TEMP`、`HOME` 与当前目录之后结果相同；1 MB 的命令一次分析不超过 500 ms（本机；2026-10-27 注：负责人定，原为 200 ms） | 单元 |
| FS-50 | git 自己的写入不算 | B90、B106、B108、B114：git 子命令从不出现在 `writes` 里，worktree 会话里 `git commit` 无、`git -C <主文件夹> merge` 有 leave | 单元 |
| FS-51 | `ensureWork` | 临时目录里（synthetic）：没有 `.work` 时建出 `.work/`、内容为 `*\n` 的 `.gitignore`、`.work/tmp`；再调一次不变；已有的 `.gitignore`（内容不同）不被覆盖；删掉 `.work/tmp` 后再调会补上；工作路径不在时什么都不建；`.work` 是文件、`.work/tmp` 是文件时返回 §7.10 的原因；装了 git 时建在仓库里之后 `git status --porcelain -uall` 为空 | 单元 |
| FS-52 | `spawnHook` 与工具替换 | `workEnv`：env 里 `Temp`、`TMP`、`tmpdir` 等写法都去掉，TEMP、TMP、TMPDIR 为 `workTmp(cwd)`；env 里的 `CDPATH`、`cdpath`、`CdPath` 都被去掉，且没有新设；其余变量与 command、cwd 不变，传进来的 env 对象没被改；`workVars` 与它同值；`shellTools` 传入记下参数的 `pi`（synthetic）与设了 `shellCommandPrefix`、`shellPath` 的设置：返回名为 `bash`、`powershell` 的两个定义，`defaultActive` 为 false，`createBashToolDefinition` 收到这两个值和 `spawnHook: workEnv`，`createPowerShellToolDefinition` 只收到 `spawnHook`；`toolSource` 对 `source: 'sdk'` 返回 builtin | 单元 |
| FS-53 | App 里的 `.work` 与临时目录 | 合成端点驱动：新项目打开会话、只调读取工具，项目里没有 `.work`；Ask each time 下拒绝第一个 bash 调用之后仍没有；第一次放行的 bash 调用 `cygpath -w "$TEMP" "$TMP" "$TMPDIR" "$(mktemp)"` 的四行都在 `<项目>\.work\tmp` 下，`.work/.gitignore` 为 `*`；`defaultTools` 含 powershell 时 `[IO.Path]::GetTempPath()` 同样；输出超过截断上限的命令，`Full output:` 的路径不在 `<项目>\.work` 下（是后台进程的 `os.tmpdir()`，它的 TEMP 没变）；git 仓库项目跑过命令后 `git status --porcelain` 为空；写 `.work/n.md` 的 write 调用之前 `.gitignore` 已在；`.work` 是文件时 bash 的工具结果是 §14 的原文、日志里有 `couldn't prepare .work`，工具卡是 `Denied · Mori couldn’t prepare .work…`（Full access 下预告过 `full` 也一样）、没有 `tool-badge`；分析不了的命令（`echo "abc`）出卡，日志有 `command not analyzed (bash): unclosed quote`、没有命令原文；TaskBoard 的 task 实例里 `cygpath -w "$TMPDIR"` 同样在 `.work\tmp`；工具页 bash、powershell 显示 Built-in；新会话启用的 pi 内置工具仍是 read、bash、edit、write（另有 `memory`、`ask_user_question`），重新打开的会话不多出 powershell | App |
| FS-54 | 告诉模型 `.work` | 单元：`identityText('ask' \| 'full' \| 'none')` 的第三行都与 §14 逐字相同；App：请求的 system 里有这一行；真实：DeepSeek 上让模型“写一个统计行数的临时脚本并运行”，脚本写在 `.work/` 下，录成 `work-scratch.json`；回放这个 fixture 时 Ask each time 下写进 `.work` 的 write 不出卡（§6） | 单元、App、真实、回放 |
| FS-55 | 命令语料统计 | `fs-real.mjs` 记一条 `FS-55 …` 检查：对 `tests/fixtures/**` 与 `<数据目录>/sessions` 里的每个 bash、powershell 调用跑 `scanCommand`，没有抛错即通过；§7.13 的数字写进 detail（不含命令原文），再抄进文件系统的检查记录 `docs/v1/fs-checks.md`；解析失败的比例与按 reason 的分布在记录里 | 真实 |
| FS-56 | `limits` 的解析 | `true` 与不写相同；`limits` 里的键名写法归一、未知键丢掉；`write: false` 时去掉 `commands`、`write_paths`；`write_paths` 归一（`\` → `/`、末尾 `/`、去重、去掉被包含的项）；绝对路径、`~` 开头、出界、整个工作路径各得到 §8.2 的原文、两行格式、TaskBoard 不变；`agent_message` 的 `limits` 不合格时不开实例、不计入条数上限；空列表与 11 项由 pi 的校验拒绝；`task_edit` 的 schema 没有 `limits`；`task_create` 的 schema 没有 `read_only`、`limits` 不必填 | 单元 |
| FS-57 | 谁受什么收窄 | §8.3 表每一行：task 只按自己的 `limits`（分开时的立项、合并会话建的 task 都不带上建它的会话的收窄）；临时提问总是 `write: false`，协作模式下对话发起的带 `mcp: false`、task 发起的不带它没有的项、`agent_message.limits` 写 `write: true` 不能放宽；关闭模式下主 Agent 发起的只有 `{ write: false }`；立项、结案、订阅 `{ write: false }`；协作模式下对话与合并会话 `{ write: false, mcp: false }` 按运行开始时的模式（运行中关掉协作模式，这次运行仍受限、下一次不受限）；关闭模式的主 Agent 不受限；`agent_message.limits` 发到 task、进座位会话时不用（2026-10-28 注：只读会话（立项、结案、订阅、临时提问、`write: false` 的 task）里写文件的命令照样被拒绝，原文的规则文字改为 `only read-only commands`，file-system-permissions.md §8.11） | 单元、App |
| FS-58 | 检查与拒绝原文 | §8.4 表每一行与 §8.3 每种开头：`write: false` 拒绝 `edit`、`write`、写 `.work`、只有 `ls`、`git status` 的 `bash` 命令，不拒绝 pi 的 `ls`、`read` 工具；`commands: false` 只拒绝命令；`mcp: false` 拒绝 MCP 工具和扩展工具；`write_paths` 外的 `edit`、命令写入目标拒绝，看不出的目标（`$OUT/a`）、`cd .. && npm i` 也拒绝，`.work/` 与列表里的照常、大小写不同（`SRC/a.ts` 对 `src/`）算在里面；读取工具从不被拒绝；原文里的目标在工作路径里是相对路径、外面是绝对路径（2026-10-28 注：负责人定：只有 `ls`、`git status` 的命令在只读会话（`owner` 不是 `dialog`）里不再被拒绝，在对话会话的 `TEAM_DIALOG_LIMITS` 下照旧拒绝；只读会话的命令见 FS-118） | 单元 |
| FS-59 | 收窄先于批准 | Full access 下 `write: false` 的 task 调 `bash` 被拒绝、没有卡；在别的卡上对 `bash` 选过 “Allow for this session”、对目录选过按目录放行之后，越界的调用仍被拒绝；被拒绝的调用不进无人应答的计时、没有 `mori.away_decision`；`write_paths` 里的受保护路径仍出卡；Ask each time 下 `write_paths` 里的 `edit` 照常出卡；职责工具（`board_read`、`task_handoff`）在 `write: false` 下照常执行（2026-10-28 注：只读的 task 没有 `write`（file-system-permissions.md §8.11），写那个目录改用命令（`echo d > ../fs59-out/d.txt`），拒绝原文为 `Not allowed for this task: only read-only commands.`） | App |
| FS-60 | 工具不再开关 | 实例请求的 `tools` = pi 设置的默认工具 + MCP 工具 + 它的职责工具（立项、结案、临时提问、订阅、`write: false` 的 task 的请求里都有 `bash`、`edit`、`write`）；协作模式下对话请求里碰文件的工具与关闭模式相同，只多职责工具；来回切换模式、重新打开会话后相同；调用 `bash`、`edit` 得到 `RELAY_ONLY`、文件不变、没有卡，工具卡显示 `Denied · Team mode is on…`（实时与从会话记录载入都是）；MCP 服务在会话打开之后才连上时，协作模式下对话调用它同样得到 `RELAY_ONLY`；`mori.team` 条目没有 `tools`（2026-10-28 注：负责人定：只读会话（立项、结案、临时提问、订阅、`write: false` 的 task）的请求里没有 `edit`、`write`，见 FS-116；没写 `limits` 的 task 与协作模式下的对话照旧） | App |
| FS-61 | 角色文件的 `tools` | 写了 `tools:` 的角色文件让会话按 `agents_invalid` 拒绝启动，卡上一行 `.mori/agents/<file>: unknown field "tools"`；删掉这一行后 `Check again` 通过 | 单元、App |
| FS-62 | 写入锁 | 没写 `limits`、只写 `commands: false`、只写 `mcp: false`、只写 `write_paths` 的 task 都取锁，第二个显示 `Waiting to change files (T1)`；`write: false` 的 task 不取锁、与写 task 同时运行 | 单元、App |
| FS-63 | `board.json` | `limits` 写出与读回一致；没有限制的 task 写 `limits: {}`；带 `readOnly`、没有 `limits` 的 `board.json`（synthetic）读不出：`loadBoard` 抛出 `<path> is not a valid TaskBoard: …`（`tasks.0.limits` 缺失），会话因此按现在读不出 TaskBoard 的处理打不开（`app/src/kernel/sessions.ts:526-537`）；不写转换、不把 `limits` 当可选 | 单元 |
| FS-64 | 模型看到的限制 | 工作卡 task 行、`board_read` 的 task 行按 §14（各种组合与没有限制）；附录 A 改过的段逐字（第一句不变，`SEGMENT_SENTENCES` 照样认出每种会话）；`task_create` 的说明、`limits` 与子项的说明、Correct form；`agent_message` 的 `limits` 说明，它原来的两段说明与关闭模式对话段逐字不变；临时提问的投递（2026-10-28 注：只读会话的文字按 §14 的 2026-10-28 注，见 FS-119） | 单元 |
| FS-65 | 重新打开时的工具 | 新版本存下的会话（关闭模式与协作模式各一个，会话文件里声明的工具含全部 pi 默认工具）重新打开后不被拒绝、不被补工具：请求里碰文件的工具与保存前相同，协作模式下对话的职责工具照 §8.6 的表；检查只比 pi 设置的默认工具，声明里扩展工具（`memory`、`ask_user_question`、TaskBoard 工具）的有无不影响打开（§8.6）；会话文件里还没有 system 消息（一次请求都没发过）的会话照常打开 | App |
| FS-66 | 增强会话 | 增强会话的 `ApprovalPolicy` 为 `{ mode: 'full', canAsk: false }`；`write`、`edit`（含写 `.work`）被 `mori-memory` 拒绝（`Enhancement runs can only change memory, with the memory tool.`）；工作路径里的命令与 MCP 不出卡就执行；分析出写到工作路径外、写受保护路径的命令直接被拒绝（§6.15 的原文），文件不变，没有卡，没有计时；`team` 为真时它的实例同样，立项、结案还按 §8.3 收窄；增强会话和它的实例运行前后，这个工作路径的内部仓库没有新提交、没有新 ref，你的会话这期间空闲时，它的 This session 里没有它们这次运行的记录（你的会话也在运行时按 §17“增强会话与它的实例”一行记进你的那一段） | App |
| FS-67 | 真实模型 | 真实模型在协作模式下处理一个要读和要改的请求：立项写的 `limits` 按 §8.2 归一后存进 `board.json`；每个被收窄拒绝的调用的工具结果是 §8.4 的原文、没有批准卡、目标文件不变；对话 Agent 的写入、命令调用都得到 `RELAY_ONLY`；模型写了什么 `limits`、有没有被拒绝的调用只写进 note（2026-10-28 注：只读会话里被拒绝的命令的原文是 `<开头>: only read-only commands.`，它们的只读命令照常执行；对话 Agent 照旧 `RELAY_ONLY`） | 真实 |
| FS-68 | 工具被裁过的旧会话拒绝打开 | synthetic 会话文件，最后一次请求前声明的工具（system 消息的 `toolsAdded` / `toolsRemoved`，§8.6）只有 `read`、`board_read`、`read_session`、`agent_message`（模仿旧版本协作模式下的运行）：重新打开时 `session.open` 失败，界面显示 `Failed to open session: This session was saved by an older version of Mori and can’t be opened.`、会话行 Error（同“新建或打开失败”）；没有补工具，会话文件没被改写；声明的工具含全部默认工具、不含 `memory` 与 TaskBoard 工具的会话照常打开（只比默认工具）；pi 设置的 `defaultTools` 为 `["read","bash"]` 时，声明只有 `read`、`bash` 的会话照常打开（按设置比） | App |
| FS-69 | 焦点消息 | 窗口 `blur`、`minimize` 发 `focused: false`，`focus`、`restore`（且没最小化）发 `true`；值不变时不发（后台进程日志里 `[kernel] window focus:` 的行数与变化次数相同）；页面重新加载、Restart 后台进程后各补发一次当前值 | App |
| FS-70 | 只在不在前台时计时 | 窗口在前台时挂着的卡超过时长仍在、没有 `mori.away_timer`；失焦时每张挂着的卡收到同一个 `deadline`；失焦时新到的卡立即收到 `deadline = 到达时刻 + 时长`，`mori.away_timer` 在对应的请求事件（`mori.approval_request`、`mori.team_approval_request`、`mori.question_request`、`mori.ui_request`）之后到达；切回时每张收到 `deadline: null`；再失焦从头计（单元用注入的时钟，App 用 `MORI_AWAY_TIMEOUT_MS`） | 单元、App |
| FS-71 | 批准卡到时拒绝 | 用户会话的卡到时：`mori.approval_end { by: 'away' }`，工具结果为 §14 的原文（时长按设置），工具卡 `Denied · No answer while you were away`，重新打开会话后同样；`mori.away_decision`（`kind: 'approval'`、`agent: null`）事件与会话条目各一条；用一个 `write`（`content` 超过 300 字符）的卡到时验证：记录的 `args` 里没有 `content`、`edits`，其余每个字符串不超过 300 字符 | 单元、App |
| FS-72 | 后台实例的卡到时 | `mori.team_approval_end { by: 'away' }`；实例拿到“写进交接”的原文（task 实例，含没有 `limits` 的 task；结案会话同样），立项、临时提问、订阅拿到“写进最后的总结”的那一句（按 `GateOutput.kind`）；`mori.away_decision` 写在用户会话文件里，`agent` 带角色与 task；用户会话正在输出时条目写在这条助手消息之后 | 单元、App |
| FS-73 | 提问卡到时 | 每个问题按 `recommended` 回答，`mori.question_end { by: 'away' }`，工具结果为 §14“结果：你提交 / 你不在”一行里你不在的那句原文（时长按设置）；记录带 `answers` | 单元、App |
| FS-74 | 扩展询问到时 | 确认得到 false、选择与输入得到空；`mori.ui_end`；记录 `kind: 'extension'`、`title`；提醒里没有它 | 单元、App |
| FS-75 | Never | 设成 Never 后失焦再久也不发 `mori.away_timer`、不自动处理 | 单元、App |
| FS-76 | 设置 | 默认 5 minutes；`away.set` 写 `away.json` 并在重启后保留；文件写坏时 `away.get` 返回默认与原文、记错误日志；写不出时值不变、`error` 有原文 | 单元、App |
| FS-77 | 倒计时 | 剩 ≤ 20 秒时三种卡各显示自己的那一行，每秒刷新；切回时消失；界面重新载入后（`LiveSnapshot.awayTimers`）接着显示 | App |
| FS-78 | 提醒 | 一次运行里有自动拒绝或推荐项时：恰好一条 `mori.away_reminder` 的 `custom_message`（`display: false`），多一次请求，这次请求里最后一条助手消息之后紧跟提醒原文（有工作卡的实例，工作卡在它后面）；同一次运行里第二次自动处理不再补，自动处理之后遇到重试（`auto_retry`）时提醒照样补；停止、出错结束、已交接的 task 实例不补；只有扩展询问时不补；对话流里看不到它（实时与重新打开） （2026-10-27 注：用户会话里同一个边界多半也加了收尾检查：最后一条助手消息之后先是检查那一行（含检查块）、再是提醒，合成一次请求、不另多一次；“多一次请求”“紧跟最后一条助手消息”只对实例会话、没有检查的边界成立；App 测试用 `{ check: true }` 取这次请求，期望合成端点默认回 `finish`，见 [finish-check.md](finish-check.md) §11） | 单元、App、回放 |
| FS-79 | 提醒与 TaskBoard 投递 | 对话 Agent 的运行有提醒时，等 `agent_settled` 的程序投递（平行 Agent 规格 §5.6）在多跑的那次请求之后才开始，没有丢失、没有并发 | App |
| FS-80 | Decided while you were away | 一轮里有记录时，这一轮最后有这一块，行与 `fs-question.md` 一致（实例的行带 `<role> · T1`）；没有记录的轮没有；重新打开会话后相同 | App |
| FS-81 | 停止与关闭 | Esc 停止对话：对话自己的卡结束、计时清掉，后台卡继续计时；Stop team、关闭会话：全部清掉；切到 Full access、选 Allow for this session 后按允许结束的卡计时清掉；与到时同时到达的回答只生效一个，另一个得到 no longer pending | 单元、App |
| FS-82 | 真实模型 | 真实模型在 Ask each time 下要写工作路径外的文件、窗口失焦、`MORI_AWAY_TIMEOUT_MS` 很短：调用被拒绝，最后的总结提到被拒绝的操作，不重试同一个调用 | 真实 |
| FS-83 | 哪些会话有它 | 关闭模式主 Agent、协作模式分开时的对话、合并会话的请求 `tools` 里有 `ask_user_question`；切换模式后仍有；task、临时提问、订阅、立项（分开时）、结案实例与增强会话里没有；重新打开旧版本存下、启用工具含全部 pi 默认工具的会话后有（工具被裁过的按 FS-68 打不开）；工具页来源 Mori | 单元、App |
| FS-84 | 免批准 | Ask each time 下调用不出批准卡，`mori.tool_gate` 为 `free`；`limits` 不影响它 （2026-10-27 注：收尾检查的 `finish` 同样：Ask each time 下不出卡、`mori.tool_gate` 为 `free`，见 [finish-check.md](finish-check.md) §11） | 单元、App |
| FS-85 | 参数校验 | 0 个或 5 个问题、1 个或 5 个选项、header 13 字符、缺 `recommended` 由 pi 拒绝；推荐项不在选项里、label 重复、label 为 Other、问题重复、header 为空、长度超限按 §14 报错（`isError`，第二行 Correct form）且不出卡 | 单元 |
| FS-86 | 提问卡 | 一次调用一张卡，问题按顺序，推荐项 label 后有 ` (Recommended)`，没有预选；每个问题有 Other；单选、多选、Other 的组合按 §10.4；全部答完前 Submit 不可用；输入框里 Enter 不提交；键盘路径（Tab、↑ ↓、Space、Esc）可用 | App |
| FS-87 | 结果原文 | 提交、你不在、拒绝回答、停止四种工具结果与 §14 逐字一致，拒绝回答与停止为 `isError`、另两种不是；`details.answers` 与卡上的选择一致；工具卡状态与 §10.6 一致（实时与重新打开会话后相同）；`question.answer` 项数不对、label 不在选项里、单选给了两个、Other 为空白时命令失败，请求已结束时为 `Question <id> is no longer pending` | 单元、App |
| FS-88 | 停止与关闭 | 卡挂着时 Esc 停止：卡消失，pi 记下的工具结果是停止的原文（不是 Operation aborted）；停止中再调用不出卡；关闭会话同样 | App |
| FS-89 | 卡的排序与提示 | 有批准卡时先显示批准卡；提问卡与扩展询问卡按到达顺序、`{n} more` 计入两种；侧栏 `Needs input`、阶段行 `Waiting for your answer`；窗口不在前台时任务栏闪烁 | App |
| FS-90 | 转给立项 | 分开时答完：立项会话收到 §14 的投递并开始一次用户消息的判断；排队区没有这条；停止对话时它不回到输入框；判断完不再交给对话；你不在时投递带“not the user's choice”；合并会话、关闭模式不转 | 单元、App |
| FS-91 | 交接带选项 | `need_user` 交接带 `options`、`recommended` 被记下；别的 outcome 带它们、只带一个、推荐项不在选项里都被拒绝；没有 `options`、`recommended` 的交接照常读写（这两个字段可选）：task 都带 `limits`、交接没有这两个字段的 `board.json` 照常读出，读出的交接没有它们；带 `readOnly`、没有 `limits` 的 `board.json` 按 FS-63 读不出 | 单元 |
| FS-92 | 选项进投递 | `ask_user`、`relay`、`create_need_user`（分开与合并）按 §10.8 带上选项行；没有选项时三种投递的原文与现在逐字相同 | 单元 |
| FS-93 | 真实模型 | 真实模型在关闭模式下遇到要你选的情况调用 `ask_user_question`，`recommended` 合法；协作模式分开时 task 交接 `need_user` 带选项，对话 Agent 用卡问你，卡上的推荐项与交接一致；你不在时按推荐项继续，最后的回复提到这一点 | 真实 |
| FS-94 | worktree 名字 | 英文句子、带附加符号的、全是中文的、只有引用芯片的、超长的第一个词、带引用块的消息，名字都符合 §11.2；后缀是 6 个十六进制字符；撞名时换后缀，3 次都撞上时报 `<路径> already exists.` | 单元 |
| FS-95 | `worktreeOf` / `projectFolder` | §11.3 表里四行与大小写不同的 `.MORI\Worktrees` 都对；结果保留 cwd 的写法；对 §11.5 建出的每个 worktree，`worktreeOf(新 cwd)` 与 `mori.worktree` 的 path、branch、mainFolder 相同 | 单元 |
| FS-96 | 建 worktree 的 git 步骤 | 临时仓库里 `createWorktree`：分支 `mori/<名字>` 指向切出点；路径在 `<R>/.mori/worktrees/`；`extensions.worktreeConfig=true`；`config.worktree` 有 `core.longpaths=true`、共用配置里没有；exclude 里 `.mori/worktrees/` 只有一行（建两次也只一行）；主文件夹 `git status` 不出现它；worktree 里有 `.work/.gitignore`；含超过 260 个字符路径的仓库也检出成功 | 单元 |
| FS-97 | 建 worktree 失败的清理 | 让 `worktree add` 失败（切出点无效；超时：单元测试直接调 `createWorktree`，在 50 个文件的临时仓库上传 `timeoutMs: 1`，或经注入的 `spawn` 让 `worktree add` 换成先睡一会儿再退出的替身进程（§3.3，同 FS-02 测超时的做法）；不论进程在哪一刻被结束都要清干净）：都没有留下 worktree 文件夹、`git worktree list` 里的登记和 `mori/<名字>` 分支；配置与 exclude 行留着。设了 `core.worktree` 的临时仓库上 `createWorktree` 失败，原文 `This repository sets core.worktree, so Mori can’t create a worktree here. Move it to the main worktree’s config.worktree first.`，`git worktree list --porcelain`、`git branch` 与共用配置前后相同；子文件夹 `<sub>` 只有未跟踪文件时同样不改任何东西（原文见 FS-111） | 单元 |
| FS-98 | 开关与 Initialize git… 的出现 | 有提交的仓库：`Worktree` 开关、默认关，紧跟在权限按钮之后；没有提交的仓库：两样都没有；不是 git 仓库：`Initialize git…`；`repoInfo` 出错：两样都没有；没装 git（`MORI_GIT_PATH` 指到不存在的路径，§19.1）：两样都没有；有了你的消息、发送中、会话拥有 worktree、“Starting…”时：都没有；在 worktree 会话里 Ctrl+N 的新会话：有开关；这一栏 ≤ 460px 时只剩图标、读屏名仍是 `Worktree`，这一行不换行、不超出（同 m1-layout 的 `layoutProblems`）；开关的开、关在操作记录里为 `Turn on worktree`、`Turn off worktree` | App |
| FS-99 | 第一条消息建 worktree | 打开开关后发消息：阶段行 `Creating worktree…`；结果里同一个 `sessionId`、同一个标签；cwd 是 worktree；会话文件在 `--<worktree 编码>--` 目录下、含一条 `mori.worktree`；消息照常发出、模型的回复照常显示；发消息前选的 Full access、范围、Effort、协作模式、会话名在新会话里都还在；建 worktree 中改名、发消息被拒绝（`The worktree is still being created.`）；带一个工作路径里的文件引用发出时：引用块显示成芯片（不露出原文），`mori.ref` 条目里的 `path` 在 worktree 里，发给模型的全文与不开 worktree 时相同 | App |
| FS-100 | 建 worktree 失败 | 让 git 步骤失败：消息撤回，文字与芯片回到输入框，错误卡 `Couldn’t create the worktree: <原因>`，开关仍开着，会话仍在原文件夹、仍空闲；改好后再发能成功；单元（`startInWorktree` 用注入后会抛错的 `startUser`）：重建失败时刚建的 worktree 文件夹、登记和 `mori/<名字>` 分支都撤掉，会话在原文件夹按原 id 重建，`ApprovalPolicy` 是同一个对象，事件为同一句 `mori.prompt_error`；两次都失败时 `session.prompt` 命令失败；App：重建之后准备中失败（没有可用模型）时会话已在 worktree 里，开关不再出现 | 单元、App |
| FS-101 | 侧栏与顶栏 | worktree 会话（开着的、没开着的、重启后的）在主文件夹那一组里，行上有分支标签；组名是主文件夹名；顶栏项目名是主文件夹名；已归档行的悬停是 `<主文件夹名> · <会话名> · <分支>`；子文件夹会话的 worktree 会话归在那个子文件夹的组里 | App |
| FS-102 | 按主文件夹算项目（2026-10-27 注：合并的那条线 2026-10-26 去掉了网络区域与 Project access（WP-05），模型层只剩 `projectContext` 读主文件夹的 `.mori/models.json`；本行里区域、`projectZones`、Project access 的部分作废，见 docs/v1/walkthrough-1026-checks.md） | worktree 会话：`memory` 工具写进主文件夹的项目记忆（不报 `This project’s memory folder belongs to …`），`project.json` 记主文件夹，`mori.memory_changed` 的 `cwd` 是主文件夹；记忆页跟着 worktree 会话时 Project 一层是主文件夹、写的是主文件夹名；增强读主文件夹和它的 worktree 里的会话与反馈；Project access 只列主文件夹（会话列表里有 worktree 会话时也不多一项）；`.mori/models.json` 与 `.mori/agents` 从主文件夹读（worktree 里没有这两个文件时也生效）；在主文件夹回答过信任后同一次运行里 worktree 会话不再问；不在 worktree 里的会话结果与现在相同 | 单元、App |
| FS-103 | worktree 里读 pi 的配置 | worktree 会话的 AGENTS.md 页列出的是 worktree 里的 AGENTS.md；主文件夹里没提交的 `.pi/` 设置在 worktree 会话里不生效 | App |
| FS-104 | 归档 | 干净的 worktree 在归档后被删掉（连同 `.work/` 里的草稿），分支还在；有未提交文件的留着；被别的开着的会话用着的留着；都不弹确认 | App |
| FS-105 | 打开 worktree 不在的会话 | 归档后恢复并打开：从分支重新检出，会话照常打开、能继续对话；手工删掉文件夹后打开也一样；分支被删后打开：`Failed to open session: The branch <branch> no longer exists, so this session’s worktree can’t be restored.`，会话行 Error，Delete… 可用；手工在 `.git/worktrees/<名字>/` 写 `locked`、删掉文件夹后打开能恢复；worktree 里有目录联接（`mklink /J`）时归档清掉后文件夹不在、联接指向的目录内容不变，再打开能检出；文件夹在而登记没有（`git worktree remove` 之后手工放回文件夹）时 `Failed to open session: The worktree folder <path> exists but isn’t registered with git. Move or delete it, then open this session again.`，文件夹没被删 | App |
| FS-106 | 删除 | 确认框：干净、有改动、读不出、被别的会话用着、没装 git（`MORI_GIT_PATH`）五种写法与屏幕表一致；`worktrees.list` 返回前 Delete 不可点、返回后可点；单元（`state/worktrees.ts` 的删除流程，注入的命令让 `worktrees.list` 失败，同 `tests/unit/taskboard/stream.test.mjs` 打包界面状态模块的做法）：确认框显示“读不出”那一句、Delete 可用，点了发 `worktrees.cleanUp { paths: [worktreeOf(cwd).path], force: true }`；没有拥有的 worktree 时与现在相同；确认后 worktree 被删（有改动也删），分支还在，会话文件被删；没装 git 时会话文件被删、worktree 文件夹还在；删 worktree 失败时会话文件还在、确认框显示原文 | 单元、App |
| FS-107 | 设置页 Clean up worktrees | 只列出已归档会话留下、还在的 worktree 和它们有没有改动；没有时 `No worktrees are left from archived sessions.`，按钮不可用；确认后全部删掉，分支和会话还在；有改动的也删掉；被开着的会话用着的不删、标 `In use by an open session`；没装 git（`MORI_GIT_PATH`）时 `Git is required to clean up worktrees.`、没有列表和按钮；操作记录有 `Clean up worktrees` | App |
| FS-108 | `worktrees.cleanUp` 只删 Mori 的 worktree | 传主文件夹、`.claude/worktrees/x`、不在 `git worktree list` 里的 `.mori/worktrees/y`、任意文件夹：都不删，返回 `error`；`force: false` 时有改动的不删；`force: true` 能删登记目录里带 `locked` 的 worktree；worktree 里有目录联接时删完文件夹不在、联接指向的目录内容不变 | 单元 |
| FS-109 | Initialize git | 确认框文字与焦点；确认后：仓库建好，`.work/` 不在第一次提交里，按 `.gitignore` 提交，空文件夹也有一个提交；输入框下一行换成 `Worktree` 开关；没设 user.name 时什么都没做、显示原因；运行中拒绝；已经是仓库时拒绝；从右栏 `Not a git repository` 下的 `Initialize git…` 打开的是同一个确认框；同一文件夹里另一个开着的会话随即显示 git 状态和 `Worktree` 开关；第一次提交失败（测试用的全局配置设 `core.hooksPath` 指向一个总是失败的 pre-commit）时 `.git` 被删掉、确认框显示 `Couldn’t initialize git: <原因>`、输入框下一行仍是 `Initialize git…`，去掉那个 hook 后再点 Initialize git 成功；单元直接调 `initGit` 传很短的超时，在有大量文件的临时文件夹里失败后文件夹里没有 `.git`、没有 `index.lock`，再调一次（默认超时）成功；原来就有认不出的 `.git` 时失败也不删它；之后的快照里不再有被 `.gitignore` 忽略的文件，没写进 `.gitignore` 的 `node_modules` 进快照；操作记录有 `Initialize git` | 单元、App |
| FS-110 | 在 worktree 会话里再开 worktree | Ctrl+N 的新会话打开开关后发消息：新 worktree 在同一个 `<R>/.mori/worktrees/` 下（不嵌套），从原 worktree 的 HEAD 切出，原 worktree 里没提交的改动不在新的里面；两个会话都在主文件夹那一组 | App |
| FS-111 | 子文件夹 | 在 `<仓库>/app` 打开的会话开 worktree：worktree 在 `<仓库>/.mori/worktrees/<名字>`，工作路径是其中的 `app`，主文件夹是 `<仓库>/app`；`<仓库>/app` 只有未跟踪文件时开 worktree 失败，原文 `The folder app isn’t committed yet, so a worktree can’t start there. Commit it first.`，仓库的 worktree 登记与分支不变 | 单元、App |
| FS-112 | 不在后台清理 | 准备一个归档时留下的、有改动的 worktree，和一个文件夹被手工删掉的 worktree 会话；重启 Mori、打开和切换别的会话、跑完一轮、窗口切走再切回之后：前者的文件夹还在，后者仍在 `git worktree list --porcelain` 里（标 `prunable`，没被 prune）；之后打开那个会话才检出，进设置页点 Clean up 才删前者 | App |
| FS-113 | 真实模型在 worktree 里工作 | Full access 下，真实模型在 worktree 会话里改一个文件并提交：不出卡，主文件夹的文件不变；你说“合并到主分支”时出批准卡，`scope` 为 `outside`（命令换到工作路径外，§7），允许后合并进主文件夹，主文件夹的 `git log` 有那个提交 | 真实 |
| FS-114 | 真实模型走查 | 用你的数据目录跑 `tests/ui/fs-real.mjs`（数据目录与模型同记忆规格 §14.1、一键拉取模型规格 MD-14）：改过的身份段（三种模式各一次运行，请求里的身份段与 §14 逐字相同）；`ask_user_question`（关闭模式与协作模式分开时各一次：卡、推荐项、工具结果的原文）；自动拒绝与提醒（`MORI_AWAY_TIMEOUT_MS` 很短、窗口失焦：工具结果与提醒的原文、只多一次请求）；Full access 下写到外面的卡（原因行、scope、拒绝后文件没被写）。只断言程序保证的事，模型说了什么写进 note（模型自己的表现见 FS-40、FS-54、FS-67、FS-82、FS-93、FS-113）；录下 §19.1 的回放 fixture | 真实 |
| FS-115 | 现有功能不退步 | §19.4 改过的现有 App、回放与单元测试，以及 `v1-models-existing.mjs --id FS-115` 的全部现有套件通过（§19.3）；改过的真实层与录制脚本（`m0-real`、`m2-real`、`m4-real`、`tb-real` 与各 `*-record.mjs`）在重录与走查时跑，交付说明列为未验证 | App、回放 |
| FS-116 | 只读会话的工具 | （2026-10-28 负责人定，file-system-permissions.md §8.11）单元：`readOnlyTools` 去掉默认工具里的 `edit`、`write`，总有 `read`，默认工具里的 `bash`、`powershell`、`ls`、`grep`、`find` 照留，`installed` 里的 `grep`、`find` 加在后面、不重复；`installedSearchTools`（注入的“文件在不在”）：`rg.exe` 在 `binDir` 或 PATH 的一个目录（含带引号的目录）里时为 `grep`，`fd.exe` 同样为 `find`，都没有时为空；Team 建的实例：`write: false` 的 task、分开时的立项、结案、临时提问（协作模式与关闭模式）、订阅、只读 subagent 的白名单是 `readOnlyTools` + `mcp__*` + 它的职责工具，没写 `limits` 的 task 与通用 subagent 的白名单照旧有 `edit`、`write`。App：分开的配置（Full access）里立项、结案、临时提问、订阅、`write: false` 的 task 的请求 `tools` 为 `read`、`bash` + MCP 工具 + 它的职责工具（没有 `edit`、`write`），没写 `limits` 的 task 照旧有 `edit`、`write`；`<agentDir>\bin` 里放一个 `rg.exe`（synthetic，空文件）之后新开的只读实例的请求多 `grep`、不多 `find` | 单元、App |
| FS-117 | 只读命令的判断 | （2026-10-28，file-system-permissions.md §7.7 末尾）`scanVerdict` 的 `readOnly`：bash 的 `ls`、`cat a.txt \| grep x \| head -5`、`cd src && ls -la`、`git status && git log --oneline -3`、`git -C .. log`、`ls > /dev/null 2>&1`、`find . -name x`、`bash -c 'ls'`、`X=1` 为真；`ls > a.txt`、`ls > NUL`、`rm a`、`npm i`、`./x.sh`、`bash x.sh`、`source x.sh`、`f() { ls; }; f`、`find . -delete`、`sort -o x a`、`git commit -m x`、`git branch new`、`ls \| xargs rm`、分析不了的 `echo "abc` 为假；PowerShell 的 `Get-ChildItem \| Select-Object Name`、`Get-Content a.txt \| Select-String x`、`(Get-Content a.txt).Length`、`git status` 为真，`Set-Content a b`、`npm i`、`[IO.File]::WriteAllText('a','b')`、`$f.Delete()`、`(Get-Item a).Delete()`、`Write-Output (Get-Item a).Delete()` 为假；`result` 与同一输入的 `scanCommand` 逐项相同 | 单元 |
| FS-118 | 只读会话里的命令 | （2026-10-28 负责人定，file-system-permissions.md §8.11）单元：`checkLimits` 对五种只读会话（`task`、`ask`、`create`、`close`、`subscription`；`{ write: false }` 与 `{ write: false, mcp: false }`）的只读命令为 `null`，对其余命令（写入的、名单外的、分析不了的、工具名是 `bash` 却没有字符串 `command` 的）为 `<开头>: only read-only commands.`；`dialog` 的 `TEAM_DIALOG_LIMITS` 对只读命令仍为 `RELAY_ONLY`；路径闸：Ask each time 下只读会话的只读命令 `gate` 为 `free`、不调 `onRequest`，没有收窄的会话里同一命令照常出卡，停止中只读会话的只读命令按停止拒绝。App：Ask each time 下 `write: false` 的 task 跑只读命令（`ls`）成功、没有卡，跑写文件的命令得到 `Not allowed for this task: only read-only commands.`、文件不在、没有卡；结案会话跑只读命令成功 | 单元、App |
| FS-119 | 只读会话看到的文字 | （2026-10-28，§14 的 2026-10-28 注）`limitsText`（`write: false` 与 `write: false` 加 `mcp: false`）、`task_create` 的 `limits` 说明与 `write` 子项、`task_create` 的 Correct form、`agent_message.limits` 的说明、`MARK_LINE`、立项段那一行、结案段最后一行、临时提问段、订阅段第二行、临时提问的投递、只读 subagent 段逐字照 §14；协作模式对话段第二行、合并会话立项段那一行、通用 subagent 段不变；各段第一句不变 | 单元 |

### 19.3 不留未完成项

`tests/spec-coverage.mjs` 加规格 `filesystem`：读本文 §19.2（编号 `FS-n`），层的结果文件为 `fs-unit.json`（单元）、`fs-app*.json`（App，含 `-existing`）、`fs-replay*.json`（回放，含 `-existing`）、
`fs-real.json`（真实），`fs-partial-*.json` 不计入；带跳过或待办标记的检查一律不算通过。
`app/src`、`app/tests` 里新加的界面文字、日志与注释不能含 `tests/md-markers.mjs` 认作推迟标记的词（`TODO`、`FIXME`、`not implemented`、整词 `later`、`待实现`，不分大小写），
否则 FS-115 的 md-markers 一项失败；所以 `old` 那一行写作 `Git 2.32 or newer is required …`（§5.1）。

`npm run test:filesystem` 依次跑 `test:fs-unit`、构建、§19.1 的八个 App 套件、`fs-replay.mjs`、`node tests/ui/v1-models-existing.mjs --id FS-115`，最后
`node tests/spec-coverage.mjs --spec filesystem --allow-missing-real`，即 package.json 里写
`npm run test:fs-unit && electron-vite build && node tests/ui/fs-app-changes.mjs && node tests/ui/fs-app-rewind.mjs && node tests/ui/fs-app-gate.mjs && node tests/ui/fs-app-work.mjs && node tests/ui/fs-app-team.mjs && node tests/ui/fs-app-away.mjs && node tests/ui/fs-app-question.mjs && node tests/ui/fs-app-worktree.mjs && node tests/ui/fs-replay.mjs && node tests/ui/v1-models-existing.mjs --id FS-115 && node tests/spec-coverage.mjs --spec filesystem --allow-missing-real`
（同 `test:discovery` 的写法）。真实层由你用数据目录跑 `fs-real.mjs`；最终一遍不带 `--allow-missing-real`。

（2026-10-27 注：收尾检查先落地时，下面的 `FS-115` 改在 `FC-28` 之上建：组 = `finish` 组加本规格的套件，回放层末尾在 `FC-28` 的末尾之后，`also` 加 `FC-28`，覆盖检查的原文按 `SPECS` 的键序为 `(expected model, taskboard, memory, discovery, finish or filesystem)`；见 [finish-check.md](finish-check.md) §11）

`tests/ui/v1-models-existing.mjs` 加套件组 `filesystem` 和预设 `FS-115`（照 `MD-15` 的写法）：
`filesystem` 组 = `discovery` 组再加一键拉取模型的 App 套件（`md-app-form`、`md-app-card`、`md-app-firstrun`，与 npm 脚本 `test:discovery` 的顺序相同）、`test:md-unit` 与 `md-replay`；
App 结果写 `fs-app-existing.json`，回放结果写 `fs-replay-existing.json`，部分运行的前缀 `fs-partial-existing-`，日志目录 `fs-existing`，先跑 `test:unit`；
回放层最后依次跑 `spec-coverage --spec model`（用 MD-15 的 `MODEL_COVERAGE_CHECK`，带 `sameAs`，另写 TB-46、MEM-35 时它们的 “spec-coverage” 按名字找到它）、
`--spec taskboard`、`--spec memory`、`node tests/md-markers.mjs`（`MARKER_CHECK`，记 “FS-115 md-markers”，另写 MD-15 的回放层要用它的结果），最后 `--spec discovery`
（覆盖检查都带 `--allow-missing-real`），各记一条 “FS-115 <名字>”；同时按 `also` 另写 `MP-37`、`TB-46`、`MEM-35`、`MD-15` 的结果文件（同样的套件，记 “<编号> <脚本名>”），
各在读它的那项覆盖检查之前写：`also` 为 `MP-37` 在 `MODEL_COVERAGE_CHECK` 之前、`TB-46` 在 `TB_COVERAGE_CHECK` 之前、`MEM-35` 在 `MEM_COVERAGE_CHECK` 之前、
`{ id: 'MD-15', before: <spec-coverage-discovery 那一项> }`（在 md-markers 之后写，`writeAlso` 按 MD-15 的 tail 找 md-markers 的结果，没跑过会记成 did not run）。
模型层、TaskBoard、记忆与一键拉取模型的真实层本轮没有重跑，交付说明列为未验证。

### 19.4 现有测试

| 现有测试或规格条目 | 改法 |
| --- | --- |
| `tests/ui/m4-app.mjs`、`m4-helpers.mjs`（改动列表：`NOTE`、`change-file`、`change-entry`、`Change N · Edit/Write`、自动打开） | 改动列表的用例删掉，由 FS-12–14 代替；文件阅读器的用例保留，重读的用例改为“新的一段记到打开的文件时重读”；自动打开改为第一次收到 `mori.turn_changes` |
| `tests/ui/m4-replay.mjs:134`、`m4-real.mjs:131` | 删掉对 `Only edits and writes are listed…` 与改动列表的断言（回放的录制里没有 `mori.turn_changes`，This session 为 `No changes yet.`）；`m4-real` 改为看 This session 列出改动的文件；阅读器部分不变 |
| `tests/ui/m1-replay.mjs:264-268`（edit 后右栏自动打开、列出 README.md、有 v0 的说明） | 回放没有 `mori.turn_changes`：右栏不再自动打开，这一条改为只看修改卡与 diff；右栏的自动打开由 FS-12 测 |
| `tests/ui/m5-replay.mjs:252-258` 的 `rightPanelFollows`（用 `change-file` 的路径判断右栏跟着哪一栏） | 改为在回放里给左右两个会话各发一条标明 synthetic 的 `mori.turn_changes`（`changes`），看右栏 This session 的 `turn-file` 跟随焦点 |
| `tests/ui/tb-app-misc.mjs` 的 TB-57（`:50-52`、`:215`、`:248-260`）、`tb-replay.mjs:186` 的 `team-changes-note` 计数，与平行 Agent 规格 TB-57 | 改为：task 改过文件后 This session 列出它们、标出 Agent，没有 `Changes made by team tasks aren’t listed here.`（FS-14）；`tb-replay` 去掉 `teamNote` 一项 |
| `tests/ui/m6-helpers.mjs:952-961` 的 `topProblems`（顶栏按钮名单只许 `Toggle changes`、`Close pane`） | 名单允许 `Toggle changes` 左边多一个 `lines-indicator`（读屏名 `Changes in this session: …`）；宽于 600 px 时会话名的最小宽度按多出的按钮重算（team-switch.md“窄栏”的算法） |
| 用到 `Toggle changes` 的套件（m1–m3、m5、m6、mem-app-settings、tb-app-misc、v1-models-row-helpers） | 读屏名不变，不用改；右栏标题 `This session’s changes` 只在 `ChangesPanel.tsx`、`ChatPane.tsx` 里，测试不按它找 |
| `tests/ui/lib.mjs`、`m0-real.mjs`、`m0-smoke.mjs`、`m6-app-mcp-shared.mjs`、`m6-app-tools.mjs`、`m6-pi-config.mjs` 等设 `MORI_USER_DATA` 的启动处 | 同时设 `MORI_SNAPSHOTS_DIR` 到测试目录，测试不往真的 `%LOCALAPPDATA%` 写 |
| `tests/ui/harness/replay.js` | `workspace.status` 加进 `QUERIES`（`:335`，不占回放顺序；m6-replay 也从这里读只读查询的名单），给合成结果（synthetic，标明）：`git: ok`、`repo: null`、快照 `on`、没有文件（fs-replay 可以换成 `old`，§19.1）；`snapshots.drop` 照 `models.discoverCancel`（`:765-766`）直接应答 `{ error: null }`、记在 `status.drops`、不占回放顺序（m3-replay 的 `delete` 用例在 `mori:delete-session` 之后发它，`:240-266`），否则 `replayCommand`（`:722-734`）记 `replay mismatch`；`snapshots.diff`、`rewind`、`rewind.undo`、`workspace.initGit`、`worktrees.*` 不在现有录制里出现，只在新的 fs fixture 用到时再加；`withDefaults`（`:60-70`）合成的会话信息加 synthetic 的 `approval.allowedDirs: []`、`worktree: null`、`live.awayTimers: []`、`live.asks: []`（同现有 `teamInfo` 的做法，只补界面字段，不补模型看到的内容）；`emptyBoard()`（`:84-86`）去掉 `teamEdited`；`sameCommand` 的 `approval.forget`（`:388-389`，现在只比 `toolName`）同时比 `dir` |
| `tests/unit/taskboard/platform.test.mjs:47-139`（TB-34） | 处理器的 `ctx` 带 `cwd`（临时目录）；`policy.gateFor(name)` 的断言改成对调用判断；`setMode('all')` 改 `'full'`，`:97` 的期望改为 `{ mode: 'full', allowed: [], allowedDirs: [] }`，并按 FS-33 只放行 scope `inside` 的请求；Allow for this session 的用例用工作路径里的命令；读取与 TaskBoard 工具免批准的用例不变，免批准的集合加 `ask_user_question`（MEM-10 同）；`ApprovalEndBy` 多了 `'away'`，原有断言不变，加 FS-71 的单元用例 |
| `tests/unit/memory/text-guard.test.mjs:82-91`（MEM-13） | `insideDir`、`resolveToCwd` 改从 `pathGate.ts` 取 |
| `tests/unit/memory/text-identity.test.mjs:45、54-55、116、152`（MEM-01） | `IDENTITY_TEXT` 改为 `identityText('ask')`，`renderIdentity` 带 `'ask'`；`A1` 是 `specBlock('### A.1')` 从记忆规格附录 A.1 的 text 块读出的（`tests/unit/memory/text-helpers.mjs:228-233`），块里加上 `.work` 一行后跟着变；加 `full`、`none` 两条 |
| `tests/ui/mem-app-prompt.mjs:60-73`、`tests/ui/tb-app-flow.mjs:46、390`（MEM-01、MEM-02、TB-10） | 测试里抄写的身份段在第二行之后加 `.work` 一行（Ask each time 的权限句不变）；`mem-app-prompt` 加一步 Full access 下的身份句（FS-39）；工具段检查（默认工具 read、bash、edit、write，bash 的规则）不改、必须照样通过，只是用户会话启用的工具多了 `ask_user_question`：断言工具清单（`<tools>` 与请求的 `tools` 参数）的地方加上它，分开时对话的那一组也加上 |
| `tests/fixtures/mem/mem-enhance.json`、`mem-feedback.json`、`mem-notice.json`、`mem-tool.json` | 身份段变了（`.work` 一行；`mem-enhance.json` 的第二行换成没人能批那一句），按 AGENTS.md 重录 |
| `tests/ui/m2-app.mjs` | `OUTSIDE_TEXT`（`:67`、`:178`）与 `approval-outside` 改为原因行（`approval-scope`），外面路径的用例（`:1169-1187`）断言 `Writes outside the working directory: <真实路径>` 和按目录放行的按钮，`:1179-1184` 的 `docs/../../m2-up.md` 解析后仍在外面，断言改为原因行里的解析后路径；Allow all 的步骤（`:288`、`:347-354`、`:792-853`、`:1689-1728`）改成 Full access：确认框原文、`Full access` 标签、Full access 下写到外面仍出卡、新会话不继承；`:659` 的小字 `You won’t be asked again for any command in this session.` 改为 §6.13 命令那一句（§17“按工具名放行命令的小字”）；`:1154` 的 “Write files” 小字改为 §6.13 的 `You won’t be asked again for “Write files” in this session, except outside the working directory or in protected paths.`（Edit files 同理）；任务栏闪烁检查不变（提问卡闪烁由 FS-89 测） |
| `tests/ui/m2-helpers.mjs`、`m2-replay.mjs`、`m2-real.mjs`、`m2-record.mjs`、`tests/fixtures/m2/*.json` | 切模式的帮助函数改 Full access；`all-mode.json`、`pending-to-all.json` 改录为 Full access（文件名改 `full-mode.json`、`pending-to-full.json`）；其余带 `mori.approval_request` 的重录（载荷多了 `scope` 等字段）；`m2-replay.mjs:343-344` 的 `optionProblems` 的 `hint` 按工具分三种（命令用 §6.13 命令那句，`edit`、`write` 用带 except 的那句，其他工具不变）；`m2-real.mjs:308` 的命令小字同改 |
| `tests/fixtures/m3/ext-ui.json`、`trust-allow.json`、`trust-remembered.json`，`m4/edit-two.json`、`quote-changed.json`、`write-delete.json`，`m5/split-approvals.json`、`split-esc.json`，`m6/mcp.json`、`plugin.json`、`slash.json`；`tests/ui/m1-record.mjs:101` | 都带 `mori.approval_request`（没有 `scope`、`targets`、`allowDirs`）：分别用 `m3-record.mjs`、`m4-record.mjs`、`m5-record.mjs`、`m6-record.mjs` 重录，m3–m6 的回放用新 fixture 通过；`m1-record.mjs:101` 的 `approval.setMode { mode: 'all' }` 改为 `'full'`（新的 schema 不收 `'all'`） |
| `tests/fixtures/tb/tb-approval.json`、`tb-ask.json`、`tb-receipts.json`、`tb-team.json`，`tests/ui/tb-record.mjs`、`tb-replay.mjs`、`tb-helpers.mjs`、`tb-app-stop.mjs`、`tb-real.mjs` | 录下的请求带工具定义与事件：`task_create`、`agent_message`、`task_handoff` 的 schema，实例与协作模式对话的工具列表，用户会话多了 `ask_user_question`，附录 A 的段、工作卡，`mori.team_approval_request` 的新字段，`gate: 'all'` / `by: 'all'`：用真实模型重录（`tb-record.mjs`），`tb-replay.mjs` 用新的 fixture 通过；帮助函数里的 Allow all 改 Full access；TB-34、TB-35 的断言改用新标签；别的 fixture 里没有 TaskBoard 工具的定义，不受影响 |
| `tests/ui/page.mjs`、`m1-layout.mjs`、`m5-app.mjs`、`m6-app-row.mjs`、`m6-app-bands.mjs`、`m6-app-slash.mjs`、`m6-helpers.mjs`、`m0-real.mjs`、`m1-record.mjs`、`mem-replay.mjs` | 量宽度、找按钮时用的 `Allow all` 字串改 `Full access`（窄栏截断的量法照旧；`Full access` 比 `Allow all` 宽，按 `docs/v0/composer-pickers.md` 的量法在 280px 一栏重量一次）；`m1-layout.mjs:355`、`m6-helpers.mjs:269` 的 `NOTES.all` 与 `m2-helpers.mjs:22` 的说明 `Edits, writes, and commands will run without asking.` 改为 §17 的 `Edits, writes, and commands inside the working directory run without asking.` |
| `tests/ui/m1-layout.mjs` 的输入框下一行（`pkKind`、`ORDER`、`orderProblems`、`spacingProblems`、`slackProblems`，`:113-120`、`:347`、`:377-436`） | 新会话还没发消息时这一行多一项（测试的临时文件夹不是 git 仓库时是 `Initialize git…`）：`pkKind` 认出 `worktree`（`[data-testid="worktree-toggle"]`、`[data-testid="init-git"]`），`ORDER` 在 `permission` 之后加 `worktree`；“权限后面那一项靠 `margin-left: auto` 推开”改为“权限、开关之间是普通间距，开关后面那一项推开”，两个间距与空余的计算跟着从这一项起算；没有开关时（有消息之后）与现在相同 |
| 按 Tab 顺序走输入框下一行、数这一行子项的其他套件（`m3-helpers.mjs:186-196` 的 `inRow` 焦点、`m5-app.mjs`、`m6-app-row.mjs`） | 推送前跑一遍；在新会话里从权限按钮按 Tab 的步数多一步时，按“权限 → 开关 → 范围”改期望 |
| `tests/ui/mem-app-enhance-a.mjs`（MEM-20） | “命令不出批准卡就执行”保留；加一条：命令写到工作路径外被拒绝、原文为 §6.15、没有卡 |
| `tests/ui/m6-app-tools.mjs` 的 `builtinRows`（bash 等行的标签为 Built-in） | 不改，必须照样通过：换掉的 bash、powershell 仍显示 Built-in、顺序不变 |
| 跑过 bash 调用后列出或比较项目文件夹内容的 App / 真实测试 | 项目里会多出 `.work/`，这类检查要排除它。起草时查过 `app/tests/ui` 里的 `readdirSync`：m5-app、m6-app-bands、m6-app-row 读的是报告目录，mem-app-prompt 读的是记忆目录，都不受影响；实现时再 grep 一遍读会话 cwd 的地方 |
| 跑真实 git 的测试项目（右栏、TaskBoard 的写入锁） | `.work/.gitignore` 让 `git status` 不变；不用改，回归时确认 |
| TB-01（`tests/unit/taskboard/roles.test.mjs:65-120`、`:190-203`，`tests/ui/tb-app-roles.mjs` 的 `fields`、`fieldNames`） | 平行 Agent 规格 §4.4 表的工具那一行去掉；写了 `tools` 的文件按“未知字段”一行（`unknown field "tools"`）；读出全部字段的检查去掉 `tools` |
| 写了 `tools:` 的 synthetic 角色文件：`tests/unit/taskboard/teamHarness.mjs:22`（reviewer.md；模块载入时断言 `SPLIT.problems` 为空，不改的话引用它的 taskboard 的 align、flow、lifecycle、runEnd、team 与 memory 的 core-team、text-callers、text-helpers、text-sections 单元测试文件全部载入失败）、`team.test.mjs:415`（memory.md）、`roles.test.mjs:273`（`unknown tool "shell"`）、`tests/unit/memory/text-sections.test.mjs:286-300`（MEM-02 的 chat.md `tools: [read]`）、`tests/ui/tb-app-roles.mjs:579-582` 的 `problemRows`、`tests/ui/mem-app-prompt.mjs:783-800` 的 readonly 步骤（MEM-02、MEM-11）、`tests/ui/tb-app-sched.mjs:85` 的 `mcpProject`（executor 写了 `tools: [...]`，MCP 工具改由 `.pi/mcp.json` 照常给）、`tests/unit/taskboard/roles.test.mjs:54-60` 的 `teamOf62()`（chat、planner、reviewer 写了 `tools:`，第 311、352、364、399、411、457 行的六处调用都用它，期望里随之没有 tools 字段）、`tests/ui/tb-app-roles.mjs:755-756` 的 `FIELD_ROLES`（planner、executor，上一行已含） | 去掉这些文件里的 `tools:` 行；`problemRows` 的 `unknown tool`、`TaskBoard tool` 两行换成一行 `unknown field "tools"`；`roles.test.mjs:273` 的期望改为 `unknown field "tools"`；text-sections 与 mem-app-prompt 里 `chat.md tools: [read]` 的用例删掉（由 FS-61 覆盖），记忆规格 MEM-02 同步注明 |
| `tests/unit/taskboard/roles.test.mjs:386-450`（TB-24、TB-09、TB-03、TB-04、TB-33 对 `toolAllowlist`、`dialogTools` 的断言） | 改测 `instanceTools`：五种实例都是默认工具 + `mcp__*` + 它的 TaskBoard 工具，关闭模式的临时提问没有 TaskBoard 工具；`dialogTools` 的断言改测 §8.6 职责工具的表（`applyDutyTools` 在 `team.test.mjs` 里测）；另加 worktree 路径从主文件夹读 `.mori/agents` 的用例 |
| TB-03（`tests/ui/tb-app-roles.mjs` 的 `withoutMemoryTool`、`withoutMemoryRow`，`:281-284`；`v0Compare`，`:344-360`） | 请求的 `tools` 与工具页的行在比较前除 memory 外同样去掉 `ask_user_question`（用户会话一直启用它，§10.1） |
| TB-04（`tests/ui/tb-app-ask.mjs` 的 `WRITE_TOOLS` 与 `banned`，`:44`、`:179`） | “新开只读实例（请求里没有 `bash`、`edit`、`write`、`agent_message`）”改为：请求里有默认工具、没有 `agent_message`，调用 `edit`、`bash` 得到 `Not allowed for this question: no file changes or commands.`、文件不变 |
| TB-05（`tests/ui/tb-app-modes.mjs` 的 `offShape`、`teamShape`，`:513-524`） | 协作模式下对话请求的判断不再是“只有读取类与三个 TaskBoard 工具”，改为“碰文件的工具与关闭模式相同，多 `board_read`、`read_session`，有工作卡与协作模式的段”；“运行中改模式，这次运行的工具不变”照旧 |
| TB-09（`tb-app-roles.mjs` 的 `dialogTools`、`createTools`、`readOnlyDialog`、`lateMcp`、`instances`、`restartDialog` 各步） | 整条改写为：协作模式下对话会话请求里碰文件的工具与关闭模式相同、只多职责工具（含 `ask_user_question`），调用 `bash`、`edit`、MCP（含会话打开后才连上的）得到 `RELAY_ONLY`、文件不变、没有卡；立项、结案的请求里有默认工具与 MCP，调用写入、命令得到它们的拒绝原文；对话的工作卡带立项的决定；`tools: [read]` 的两项去掉（改由 FS-61 覆盖）；“退出 App、重新打开、关掉协作模式后又有 `bash`、`edit`、`write`”保留。memory 的各组照记忆规格 §7.6 |
| TB-10 | 加一项：协作模式下合并会话调用 `bash` 得到 `RELAY_ONLY` |
| TB-13、TB-30、TB-44（`tests/unit/taskboard/text.test.mjs`） | 带 `task` 的读法里“是否只读”与 task 实例卡片的 `· read-only` / `· changes files` 改为 `· Limits: …` 或不写；附录 A 的段按 §14 改，固定的第一句不变，所以 `tests/fake-endpoint/scripts.mjs` 的 `SEGMENT_SENTENCES` 不变 |
| TB-23（`tests/unit/taskboard/route.test.mjs`、`tests/ui/tb-app-sched.mjs` 的 `lock`） | “只读 task”改为 `limits.write` 为 false 的 task；写 task 的判断用 `limits` |
| TB-24（`tb-app-sched.mjs` 的 `readOnly`、`readOnlyEdit`） | 改为“收窄的 task”：`write: false` 的 task 的请求里有默认工具，调用写入、命令被拒绝；`task_edit` 没有 `limits`，写了也被丢掉，`board.json` 里的 `limits` 不变 |
| TB-33 | “订阅实例只读”改为：请求里有默认工具，调用写入、命令得到 `Not allowed in a subscription: no file changes or commands.` |
| 平行 Agent 规格 TB-34 | “Allow all 之后实例不再出卡”改为“Full access 之后实例在工作路径里不再出卡，写到外面仍出卡”；括号里“同一时刻最多一个实例有要批准的工具”不再成立（立项、结案、临时提问、订阅现在有 MCP，Ask each time 下会出卡），单元测试照旧覆盖挂起中的同名请求一并允许；后台卡写明角色与 task 之外还带原因行 |
| TB-45（`tests/ui/tb-real.mjs`、`tb-real-helpers.mjs` 的 `ASK_FORBIDDEN`、`WRITE_TOOLS`） | “对话请求里没有写入类工具”改为“对话会话在协作模式下的写入、命令调用全部得到 `RELAY_ONLY`，没有成功的写入”；“临时提问只读”改为“临时提问的实例会话里没有成功的 `edit`、`write`、命令”；Allow all 改为 Full access（同 TB-34） |
| TB-49（`tests/unit/taskboard/tools.test.mjs`） | `task_create` 的 Correct form 按 §14；`:53` 的 `read_only: true` 改为 `limits`；`:129` 的参数顺序改为 `request`、`title`、`description`、`assignee`、`limits`、`depends_on` |
| 平行 Agent 规格 §6.3 的 `task_handoff` schema 测试（`tests/unit/taskboard/*` 里的 schema 快照、§7.5 的严格 schema） | schema 多了 `options`、`recommended`；严格 schema 多两个可为 null 的字段；C 级标签不变 |
| `tests/unit/taskboard/board.test.mjs`、`route.test.mjs`、`team.test.mjs`、`teamHarness.mjs`、`flow.test.mjs`、`lifecycle.test.mjs`、`runEnd.test.mjs`、`text.test.mjs` | 构造 task 的 `readOnly` 改为 `limits`（`readOnly: true` → `limits: { write: false }`，`false` 改为 `limits: {}`）；`loadBoard` 加旧文件的一项（FS-63） |
| `tests/unit/taskboard/team.test.mjs:75`、`lifecycle.test.mjs:283-284`（`teamEdited`；同文件 `:240-262` 的两条 TB-09 见下面另一行）；`team.test.mjs:509-525`（TB-44 的启用工具，`:519`）、`:529-538`（TB-09 的 `guardCall`）；`tests/unit/memory/text-sections.test.mjs:264-284`（MEM-02、MEM-04，`:273`）；`tests/unit/memory/text-callers.test.mjs:57-59`（MEM-10） | 删掉 `teamEdited` 的断言（改由 FS-14 测）；TB-44 的期望改为默认工具加 `board_read`、`read_session`、`agent_message`；TB-09 的这条改测路径闸第 2 步：对话会话的 gate 带 `TEAM_DIALOG_LIMITS` 时 bash 得到 `RELAY_ONLY`；text-sections 改为 `on.requestTools.includes('bash')` 为真、只多职责工具；MEM-10 改为对 `memory` 调用 `decide` 得到 `free` |
| `tests/unit/memory/text-callers.test.mjs` | 第 113 行“分开时对话调用 `memory` 得到 `RELAY_ONLY`”改为：`memory` 是职责工具，不被收窄拒绝；协作模式分开时它不在启用的工具里（pi 回 `Tool memory not found`，App 层的 MEM-11 已覆盖）；`CHAT_READ`（`chat.md` 写 `tools: [read]`，`:91-97` 定义、`:104-106` 断言）这一组去掉：这样的文件现在按 `agents_invalid` 拒绝启动；第 171 行构造 task 的 `readOnly` 改为 `limits` |
| `tests/ui/mem-app-team.mjs`（MEM-31） | “只读 task”的判断改读 `board.json` 的 `limits.write` |
| `tests/ui/mem-app-team.mjs:75-76`、`:584-587`（MEM-31 的不合格角色文件） | `BAD_ROLE` 写的是 `tools: ['read', 'hammer']`，FS-61 之后问题行变成 `unknown field "tools"`：`BAD_ROLE` 改为另一种不合格的头 `seats: ['nowhere']`，`BAD_PROBLEM` 改为 `.mori/agents/bad.md: unknown seat "nowhere"`（`app/src/kernel/roles.ts:220` 的写法），检查名里的 “an unknown tool” 改 “an unknown seat”；记忆规格 MEM-31 同步注明 |
| `tests/unit/taskboard/lifecycle.test.mjs:240-262`（TB-09 两条） | `teamEntries` 只写 `{ mode }`；`prepareUser` 先把启用的工具设成 `OFF_SET + agent_message`（新版本存下的会话；恢复出裁过的一组由 sessions.ts 按 FS-68 拒绝，不在 team.ts）；断言两种模式下 `before_agent_start` 之后碰文件的工具不变（`OFF_SET` 都在），最后一条 `mori.team` 条目深等于 `{ mode: 'always' }` |
| `tests/unit/memory/core-team.test.mjs:58-73`（MEM-11） | 协作模式分开时 `startUserRun` 之后 `getActiveTools()` 排序后等于 `[...OFF_SET, 'board_read', 'read_session', 'agent_message']`（不启用 `memory`，§8.6 的表、记忆规格 §7.6），对话经路径闸调 `bash` 得到 `RELAY_ONLY`；`setMode('off')` 之后等于 `[...OFF_SET, 'agent_message', 'memory']`（不变）；`teamEntries` 不再写 `tools`；记忆规格 MEM-11 同步注明 |
| 会话引用的 Turn N（`app/src/renderer/src/state/sessionRefs.ts`，§5.3）与 `tests/fixtures/m5/ref-*.json` | 模型看到的引用文字只在会话里有 `mori.wake` 条目时变；现有的四个 `ref-*.json` 里没有 `mori.wake`（复核时 grep 为 0），不重录；`tb-app-*` 的协作模式套件加一项：会话引用芯片的 `turns a–b` 与 This session 的组编号一致（FS-12） |
| `tests/fake-endpoint/scripts.mjs:146`、`scenarios/ask.mjs`、`flow.mjs` 及其余带 `read_only` 的脚本 | `read_only: true` 改为 `limits: { write: false }`，`read_only: false` 去掉；不改的话 `prepareToolArgs` 丢掉 `read_only`，只读 task 变成写 task，排队与写入锁的检查会变 |
| `tests/ui/m2-app.mjs`、`tb-app-*.mjs`、`m3` 的扩展询问测试（含 `ext-ui-card`） | 窗口在测试里可能不在前台：卡都在默认 5 分钟内答完，不受影响；等卡超过几分钟的测试启动时 `away.set { timeout: 'never' }`；卡的排序合并了提问卡，只有扩展询问时行为不变。不改断言 |
| 现有回放的 fixture | 现有录制里没有 `agent_before_settle` 的提醒，只有新录的 `fs-replay` fixture 用到；现有回放不变 |
| `tests/ui/m3-app.mjs`、`m3-replay.mjs`、`m3-real.mjs` 的删除确认框文字、侧栏分组 | 不改：不在 worktree 里的会话文字与分组不变（`DELETE_TEXT` 仍是原文）；推送前的回归照跑 |
| `tests/unit/memory/enhance-feedback.test.mjs`、`core-files.test.mjs` | 原有用例不改（`projectDirName` 不变，`projectFolder` 在调用它之前）；加 worktree 会话的会话与反馈被选中、worktree 路径的 `projectDir` 不报占用的用例（FS-102） |
| `tests/unit/modelLayer.test.mjs`、`modelConfig.test.mjs` | 原有用例不改（`normalizeProjectPath` 不变）；加 worktree 路径的 `projectContext`、`registerProject` 用例 |
| 记忆规格 §14 里按“工作目录完全相同”判断增强会话与反馈的条目；平行 Agent 规格 §17 读角色文件的条目 | 断言改成 `projectFolder` 相同；角色目录写成 `<projectFolder(cwd)>/.mori/agents`；不在 worktree 里的会话结果不变 |
| `tests/spec-coverage.mjs`、`tests/unit/taskboard/spec-coverage.test.mjs`、`tests/unit/fs-reporter.mjs`（新） | 覆盖检查加 `--spec filesystem`（§19.3）；TB-46 的单元测试加查 `--spec filesystem` 读到 §19.2 的每个 FS 条目与层、`fs-` 结果文件归到哪一层（`fs-partial-*` 不算）；报告器用严格模式；`spec-coverage.test.mjs:305-311` 的期望改为 `unknown --spec "board" (expected model, taskboard, memory, discovery or filesystem)`；`:145-148` 的循环加 `discovery`，另查 `fs-unit.json`、`fs-app-existing.json`、`fs-replay-existing.json`、`fs-real.json` 不归其他四份规格，`md-`、`mem-` 等文件也不归 filesystem（2026-10-27 注：收尾检查先落地时原文为 `(expected model, taskboard, memory, discovery, finish or filesystem)`，循环与“不归其他规格”的检查含 `finish`、`fc-`，见 [finish-check.md](finish-check.md) §11） |
| `tests/ui/m6-app-settings.mjs:344-346`、`tests/ui/mem-app-settings.mjs:713-715`（MEM-28） | 设置页分节改为 Models、AGENTS.md、UI issues、General、Storage（§9.6、§11.10），打开时仍落在 Models |
| `tests/ui/v1-models-existing.mjs` | 加套件组 `filesystem` 和预设 `FS-115`（§19.3） |
| `tests/ui/fs-app-team.mjs`（FS-57、FS-60）、`fs-team-helpers.mjs` 的 `RULE` | （2026-10-28，只读会话）只读会话里写文件的命令的拒绝原文改为 `only read-only commands`（`RULE.readOnly`）；`instanceWant` 按种类：只读会话为 `read`、`bash` + MCP + 职责工具，`write: false` 的 task 同样；加 FS-116、FS-118 的步骤 |
| `tests/ui/fs-real-team.mjs`（FS-67） | （2026-10-28）`DUTY_TOOLS` 加 `finish`、`subagent`（同 `pathGate.ts`，U52）；只读会话里的命令按 `scanVerdict` 判断：只读命令应当执行，其余应当得到 `only read-only commands`；只读会话的请求里没有 `edit`、`write` |
| `tests/ui/tb-app-modes.mjs` 的 TB-24 与 `tests/fake-endpoint/scenarios/modes.mjs` 的 `tb-modes-lookback` | （2026-10-28）T1（`write: false`）的请求里有 `read`、`bash`，没有 `edit`、`write`；T1 先用只读命令 `ls` 列目录（成功），交接证据引用这次成功的调用；TB-29 照旧读到 T1 的会话 |
| `tests/ui/tb-app-sched.mjs`（TB-24 的 `readOnly`）、`tb-app-ask.mjs`（TB-04、TB-33）、`tb-app-roles.mjs`（立项、结案的收窄与工具）、`tb-app-flow.mjs`（主路径 (d) 临时提问的工具）、`tests/fake-endpoint/selfcheck-team.mjs`、`scenarios/ask.mjs` 的 `tb-ask-subs-ro` | （2026-10-28）拒绝原文与工作卡的 `Limits:` 按 §14 的 2026-10-28 注；只读会话的请求里是 `read`、`bash`，没有 `edit`、`write`，对它们的调用不再是收窄拒绝（pi 回 `Tool edit not found`），改测不是只读命令的命令（写文件的、`tee`、名单外的程序）被拒绝；`tb-ask-subs-ro` 里订阅的命令 `echo subscription-should-not-run` 是只读命令，改为 `npm run subscription-should-not-run` |
| `tests/ui/sa-app.mjs`（SA-05）、`tests/ui/sa-real.mjs`、`tests/unit/subagent/*.test.mjs` | （2026-10-28）只读 subagent 的请求里没有 `edit`、`write`；它的段第三行按 §14；被拒绝的命令原文为 `Not allowed for this question: only read-only commands.` |
| `tests/unit/filesystem/limits.test.mjs`、`narrowing.test.mjs`、`gate-order.test.mjs`、`work.test.mjs`、`team-ask.test.mjs`，`tests/unit/taskboard/team.test.mjs`、`text.test.mjs`、`tools.test.mjs`、`spec-coverage.test.mjs`、`teamHarness.mjs`，`tests/unit/finish/extension-instances.test.mjs`，`tests/unit/memory/core-team.test.mjs`、`text-callers.test.mjs`、`text-sections.test.mjs` | （2026-10-28）`write: false` 的拒绝原文与文字按 §14 的 2026-10-28 注；FS-58 里“只有 `ls`、`git status` 的命令也拒绝”改测对话会话，只读会话的写文件命令得到 `only read-only commands`；实例的工具按 §8.11；`narrowing.test.mjs` 里 FS-60 的两条 Team 用例（只读实例的工具）移到 `readonly.test.mjs` 的 FS-116，FS-64 的“段里没有 read-only”改为没有 `read_only`（新文字里有 read-only commands）；建 Team 的参数加 `searchTools`（`teamHarness.mjs` 可传入）；`spec-coverage.test.mjs` 的 FS 条目数与各层列表加 FS-116–119 |
