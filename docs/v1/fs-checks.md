# 文件系统 检查记录

依据：[构建规格](../specs/file-system.md)（§0–§5、§11–§19）与 [续篇](../specs/file-system-permissions.md)（§6–§10），下称“规格”；
它们实现 [文件系统 Proposal](../proposals/file-system.md) 第一版（2026-10-26）。在 `claude/happy-bell-a93948` 分支上做（从 `app-v0` 的 8004ddd 切出），
按 proposal §11 第 3 条分三步提交：权限（§6–§10）→ git（§3–§5）→ 并行（§11 与 §8 的 `limits`）。

## 状态

三步都已提交；完整测试没跑完，App 层与真实层还有失败与没跑的（见“推送前的完整测试”）。2026-10-27 负责人让直接把
`claude/happy-bell-a93948` 推到远端、不合并进 `app-v0`，并写交接说明（发在 GitHub issue 上）。
之后在 `wt/fs-fixes` 上修了完整测试里失败的 7 个 App 套件（`--only` 都通过）并压缩 `test:fs-unit`（23–26 秒，仍没到 20 秒），
见“已知失败的修复”。

### 第 1 步：权限（§6–§10，2026-10-27 提交）

- 实现：路径闸（`pathGate.ts`、`approval.ts` 的判断顺序、两种模式、受保护名单、按工具名与按目录放行、没人能批）、命令分析（`commandScan.ts`、
  `commandScanBash.ts`、`commandScanPs.ts`）、收窄的纯函数（`limits.ts`；TaskBoard 的接线在第 3 步）、`.work` 与命令的 TEMP / TMP / TMPDIR
  （`workspace.ts`、`shellTools`）、身份段（`identityText`）、你不在（`away.ts`、主进程的焦点、`extensionUi.ts`）、`ask_user_question`（`askQuestion.ts`、
  提问卡、转给立项、交接的选项）；界面：批准卡的原因行与第二个按钮、权限按钮与菜单、提问卡、倒计时、Decided while you were away、设置页 General。
- 过程：契约（`shared/workspace.ts`、`shared/protocol.ts`、内核接口与文件归属）→ 实现 workflow（6 路并行加接线与界面组件，每路一个审查、一个修复，24 个 agent）
  → 只读审查 workflow（7 个角度，24 条里确认 21 条，按文件归属修好）→ 测试 workflow（9 路，27 个 agent）→ 集成。
- `npm run test:min` 通过，本机 111 秒（≤ 2 分钟）：`test:unit` 418/418、`test:tb-unit` 343/343、`test:mem-unit` 224/224、`test:md-unit` 197/197、
  `test:fs-unit` 521/521（单独跑 10 秒，≤ 20 秒）。
- FS-49 的计时在 `test:fs-unit` 十几个文件同时跑时会被拉长几倍（线程 CPU 时间，降频与超线程争用）：一次实测 `cd ..; npm i; ` 重复到 1 MB 单独 125 ms、
  同时跑 594 ms。计时帮助函数超过 500 ms 时停 400 毫秒再量、最多 8 次、取最快的一次（只量分析本身）；命令分析的性能修正后 bash `cd .. && npm i; `
  单独 516 → 187 ms，PowerShell `cd ..; npm i; ` 203 → 125 ms，随机 70 万条命令前后结果相同。
- 没跑（按测试分层留到推送前）：`fs-app-gate`、`fs-app-work`、`fs-app-away`、`fs-app-question` 与改过的现有 App、回放、真实层套件；录 fixture 与真实模型走查在第 3 步之后做。
  已知在只有第 1 步的构建上会失败的 App 检查（第 3 步给实例 MCP 工具、收窄之后才通过）：FS-72 的结案、临时提问、立项、订阅实例的卡，FS-38 的 `RELAY_ONLY` 两项。

### 第 2 步：git（§3–§5，2026-10-27 提交）

- 实现：找 git 与运行 git（`git.ts`：按键排队、超时与输出上限、`GitRun.signal`、Windows 上结束整棵进程树、内部仓库的调用直接起
  Git for Windows 启动器旁边真正的 git）、认仓库与 git 状态（`workspace.ts`：两个 rev-parse、porcelain v2、500 条、去抖、同一时刻一次读）、
  内部仓库与快照（`snapshots.ts`、纯函数 `timeline.ts`：归属、隔离配置与 `info/attributes`、排除与 `add -f` 跟踪的被忽略文件、上限与暂停、
  段与归属、运行记录与 `mori.turn_changes`、保留 100 轮与 `prune`、`snapshots.drop`、陈旧的锁、有序退出）、Rewind 与 Undo（`rewind.ts`）、
  接线（`sessionWorkspace.ts`，`sessions.ts` 只加调用，1779 行）；TaskBoard 删 `teamEdited`、给出运行的 Agent；
  界面：右栏 Changes（git 状态与 This session）、顶栏 `+N −M`、阅读器重读、Rewind 按钮与菜单、冲突对话框、通知与 Undo、进行中与错误行、阶段行。
- 过程：契约 §3 → 实现 workflow（7 路，每路一个审查、一个修复，20 个 agent）→ 集成（几处跨文件的交接）→ 只读审查 workflow
  （8 个角度，16 条里确认 14 条，按文件归属修好，另补 3 处）→ 测试 workflow（11 路，33 个 agent）→ 集成（测试报的 3 个源码问题、
  `test:fs-unit` 的时长，见上面“负责人不在时定下的选择”第 12–15 条）。
- `npm run test:min` 通过，PowerShell 里 97 秒（≤ 2 分钟）：`test:unit` 418/418、`test:tb-unit` 344/344、`test:mem-unit` 224/224、`test:md-unit` 197/197、
  `test:fs-unit` 800/800。`test:fs-unit` 单独跑 PowerShell 里连续四次 20.6–20.9 秒（§19.1 要求 ≤ 20 秒，多 0.7 秒左右，第 15 条），Git Bash 里约 21–24 秒；
  关键路径是 `snapshots.test.mjs` 的 FS-26 嵌套仓库那一串（整组里约 18 秒）。FS-49 在整组里一直再量到真实 git 的文件跑完（约 19 秒），单独跑 1 秒多。
- 没跑（按测试分层留到推送前）：`fs-app-changes`、`fs-app-rewind`、`fs-replay` 与改过的现有 App、回放、真实层套件（m1、m4、m5、m6、tb、mem 的相关步骤，
  `lib.mjs` 等启动处的 `MORI_SNAPSHOTS_DIR`）。预计推送前要看的：两栏同一文件夹的 m5 用例（`m5-app` 的 followFocus、toggleOther，`m5-real`）
  现在两边都会记下重叠的那一段，原来的“另一栏的文件不在这一栏”的断言可能要改成按轮看、只许带 `turn-overlap` 的组里出现。
- 录 fixture 与真实模型走查：第 2 步不改模型看到的文字（`mori.turn_changes`、`mori.rewind` 是不进上下文的条目；Rewind 后再记的 `mori.pick` 同现在），
  会话引用照旧不交投递（第 2 条），所以不重录；第 3 步之后一起做。

### 第 3 步：并行（§11 与 §8 的 `limits`，2026-10-27 提交）

- 实现：worktree 与 Initialize git（`workspace.ts` 的 worktree 部分、`worktreeSession.ts`：取名、切出、检查与清理、按原 id 与同一份
  `ApprovalPolicy` 重建会话、引用换进 worktree、建 worktree 中的拒绝、失败的几种、`mori.worktree` 与 `SessionInfo.worktree`、打开时恢复、
  `worktrees.list` / `cleanUp`、`workspace.initGit`）；按主文件夹算项目（记忆、增强、反馈、模型层、角色目录、信任回答、侧栏与顶栏）；
  TaskBoard 的 `limits` 与收窄（`LimitsSchema`、`board.json` 必填、写入锁、`task_create` / `agent_message` 的参数与 §14 文字、
  `narrowingFor` / `userNarrowing` 接到路径闸、`applyDutyTools`、`instanceTools`，删掉角色的 `tools` 与按工具开关的做法）；§8.6 旧会话拒绝打开；
  界面：Worktree 开关与 Initialize git…、建 worktree 中、侧栏分组与分支标签、删除确认框、设置页 Storage、Initialize git 确认框。
- 过程：契约 §4.4 → 实现 workflow（7 路，每路一个审查、一个修复）→ 只读审查 workflow（8 个角度，12 条里确认 8 条，修好）→ 测试 workflow
  （负责人说用量不多，中途停下；已写完的单元测试与现有测试的迁移留下，其余在下面“没做”）→ 集成。
- `npm run test:min` 通过，PowerShell 里 109 秒（≤ 2 分钟）：`test:unit` 422/422、`test:tb-unit` 353/353、`test:mem-unit` 226/226、
  `test:md-unit` 197/197、`test:fs-unit` 956/956。`test:fs-unit` 单独跑约 34 秒（§19.1 要求 ≤ 20 秒）：第 3 步加了 worktree、worktree 会话、
  收窄与项目的单元测试（真实 git）；负责人要求只做必需的，没再压缩，记为没达到。
- 集成时修的：信任询问（worktree 与主文件夹同时在问时只有询问框写的那个文件夹记住，§11.7）；FS-02 真实 git 的停止与超时用例改用不起子进程的过滤器，
  并在用例结束时收拾漏掉的 sh（超时落在 git 起过滤器半途时，之后起来的 sh 不在 taskkill /T 列出的树里）；`git.ts` 等 `close` 的宽限到时先让事件循环再走两轮。
- 没做（测试 workflow 停下时还没写到）：App 套件 `fs-app-team.mjs`（FS-57、59–62、65、66、68 的 App 层）与 `fs-app-worktree.mjs`（FS-98–107、109–112 的
  App 层）不存在，这些条目的 App 层没有覆盖；`spec-coverage --spec filesystem` 会报它们缺失。（2026-10-27 已在 `wt/fs-suites` 补写，
  见文末“补写的 App 套件与回放 fixture”。）
- 没跑：所有 App、回放与真实层套件（见“推送前的完整测试”一节）。

## 推送前的完整测试（2026-10-27，没跑完）

负责人让直接推送、写交接说明，完整测试在跑到一半时停下。下面是停下时的结果；日志在 worktree 的
`app/test-results/fs-existing/<套件>.log`（不进 git），失败的原因没查完的写“待查”。

- 构建通过。`node tests/ui/v1-models-existing.mjs --id FS-115` 停在 `mem-app-prompt` 中途：之前的 24 个套件里 17 个通过
  （`m0-smoke` 退出码 0、记 1 条 FAIL，`m2-app`、`m3-app`、`m6-app-*` 五个、`v1-models-app-settings`、`v1-models-app-switch`、`tb-build-base`、
  `tb-app-flow`、`tb-app-ask`、`tb-app-handoff`、`tb-app-sched`、`tb-app-models`、`tb-app-stop`），7 个失败：
  - `m1-app`（1 条）：对话的进行中行在 Waiting for the model… 之前多了 Taking a snapshot…（第 2 步的阶段行），原断言只许
    Waiting → Responding。按规格改断言还是改实现，待查。
  - `m4-app`（1 条）：会被运行的 `.bat` 不打开、改为在资源管理器里选中的那一条，待查。
  - `m5-app`（3 条）：焦点在右栏按 Esc 只停右栏；右栏跟随焦点（Changes 现在是 git 状态与 This session，没有 git 的文件夹显示
    Not a git repository 与 Initialize git…）；`runningSource` 等 `ref-problem` 超时。与第 2 步预计的两栏同一文件夹用例有关，待改。
  - `v1-models-app-session`（1 条）：MP-22 overflow-once（压缩后在同一模型上重试），待查，可能是计时。
  - `tb-app-roles`（1 条）：teamFail 找不到 mori-team 工厂那一行（第 3 步删了角色的 `tools`，测试改源码的位置变了），要改测试。
  - `tb-app-modes`（2 条）：TB-56、TB-08（顺序与时间），待查，可能是计时，要单独重跑。
  - `tb-app-misc`（5 条）：TB-57 的四条（任务第一次 `mori.turn_changes` 时右栏不自己打开 Changes，FS-12；This session 里
    README.md 的 executor (T1) 归属，FS-14；两轮的顺序；重开后读回）与 FS-12 的会话引用 turns 1–2。是第 2、3 步的真问题，要修实现。
- 没跑到：FS-115 剩下的部分（记忆与一键拉取模型的 App 套件、各回放、`md-markers`、覆盖检查），`fs-app-changes`、`fs-app-rewind`、
  `fs-app-gate`、`fs-app-work`、`fs-app-away`、`fs-app-question`、`fs-replay`，五个 `spec-coverage`（含 `--spec filesystem`）。
- 真实层：`tests/ui/fs-real.mjs` 与 `fs-real-setup.mjs`、`fs-real-perm.mjs`、`fs-real-team.mjs`、`fs-real-wt.mjs` 已写好、提交，只核对过用法输出，
  一步都没跑（FS-21、40、54、55、67、82、93、113、114 都没验证）；没录新的 fixture，旧 fixture（m2–m6、tb、mem）也没重录。
- 打包冒烟：`npm run dist:dir` 与 `m0-smoke --exe` 没跑。worktree 的 `node_modules` 是 junction，从这里打出来的 asar 不对；
  要在主检出里切到这个分支后再打包。

## 已知失败的修复（2026-10-27，`wt/fs-fixes`，从 `6470920` 起）

上面 7 个失败的 App 套件逐个按规格核对，修实现或测试；各套件只用 `--only` 跑受影响的步骤（m1-app 没有 `--only`，改了它就整套跑），
开发构建，界面没有锁屏（m1 的 Copy 检查照常通过）。

**这台机器的环境**：Git for Windows 现在装在 `D:\Git`（不在 Program Files），PowerShell 的 PATH 里只有 `D:\Git\cmd`。

- pi 的 bash 工具按 Program Files 与 PATH 找 Git Bash：从 PowerShell 起的 App 套件里命令一律 `No bash shell found`（m1 的 escStop、queueSteer、
  kernelExit、崩溃，m4 的三条命令检查）。这些套件的结果都在 PATH 后面加上 `D:\Git\bin` 跑（原来的完整测试多半是在 Git Bash 里跑的）。
- 单元测试的 `real-git.mjs` 只认 `C:\Program Files\Git`，找不到时候选为空，等于没装 git：`test:fs-unit` 在这台机器上 175 条失败；
  FS-02 的进程树用例写死了 Program Files 的启动器。改为与 `kernel/git.ts` 相同的找法（见下面 `test:fs-unit` 的时长）。

| 套件 | 失败 | 原因 | 修法 | `--only` 结果 |
| --- | --- | --- | --- | --- |
| `tb-app-misc` | TB-57 的四条（第一次 `mori.turn_changes` 时右栏自己打开、README.md 的 `executor (T1)`、两轮的顺序、重开后读回） | 分开时立项在对话写下你的消息之前派出 T1，T1 改 README.md 的那一段（T1 开始 → 对话开始的快照）落在会话里还没有你的消息的时候，§4.5 原文把它丢掉；会话文件里只有 notes.txt 那一轮 | 实现：`kernel/timeline.ts` 把这样的段先留着，记进之后写下的第一条你的消息（上表第 22 条）；单元测试加两条 FS-11 | `--only changes,restart`：TB-57 三条与重开后读回通过 |
| `tb-app-misc` | FS-12 会话引用的 `turns 1–2` | 一是上面那条（This session 只有 Turn 2）；二是测试点开预览后没等读完（`Loading…`）就取各轮，取到空表 | 测试：`previewTurnsOf` 照 m5-helpers 的 `waitPreview` 等读完 | `--only changes`：TB-57 三条、FS-12、端点与页面检查全部通过 |
| `m5-app` | 焦点在右栏按 Esc 只停右栏 | 发出后先拍运行开始的快照（§4.5），右栏在快照期间就被停下，`waitPaneIdle` 先等它“生成中”最多 20 秒，这时左栏已经生成完（`leftRunning` 为假） | 测试：两栏都进入生成中再按 Esc，之后直接等右栏空闲 | 整套跑时只有这一条失败（53 条通过）；改后 `--only menuSplit,dragAndPlace,twoPanes,followFocus,toggleOther` 17 条全部通过 |
| `m5-app` | 右栏跟随焦点 | 两栏开在同一文件夹、同时运行：左栏写 docs/c.md 的那一段右栏也在跑，两边都记（`overlap: true`，§4.5 第 3 步、§5.3），右栏的 This session 照规格列出 docs/c.md | 测试：改为按轮看：各轮标题是焦点所在那一栏的消息、这一栏的文件在它自己那一轮，另一栏的文件只出现在带重叠说明的轮里（第 2 步的预计） | 同上，通过（右栏：`edit README…` 一轮列出 docs/c.md、README.md，带重叠说明） |
| `m5-app` | `runningSource` 等 `ref-problem` 超时 | E 发出后马上从会话行菜单引用它：快照期间 pi 还没写下这条消息，菜单的 Attach as context 是 `No messages yet`（不可用），`chooseByKeys` 落到别的项 | 测试：等 E 的阶段行离开 `Taking a snapshot…` 再引用 | 整套跑时这一步的四条全部通过 |
| `m1-app` | 进行中行在 Waiting for the model… 前多了 Taking a snapshot… | 规格 §4.5、fs-changes.md“等运行开始的快照”、model-chat.md 就是这样：快照期间的阶段行在 `agent_start` 之前 | 测试：最前面只许有 `Taking a snapshot…`，之后照旧先 Waiting 再 Responding | 整套 46 条全部通过 |
| `tb-app-roles` | teamFail 找不到 mori-team 工厂那一行 | 不是删了 `tools` 的缘故：打包器遇到同名的顶层变量把参数改名为 `hooks2`，测试按字面 `hooks.tools` 找 | 测试：按 `hooks\d*` 认这一行，仍要求正好一处 | `--only teamFail`：TB-43 通过 |
| `m4-app` | 会被运行的 `.bat` 改为在资源管理器里选中 | 重现不出：两次都通过（第一次 PATH 里没有 Git Bash，命令的三条因上面的环境失败，`.bat` 这条通过） | 不改 | `--only changes,toolPath,reread,openExternal` 11 条全部通过 |
| `v1-models-app-session` | MP-22 overflow-once | 不是计时：每轮之后的 `mori.turn_changes` 让 pi 把切点算成拆开的一轮，多一个 turn prefix 摘要请求（日志 400、200、200、200） | 测试：压缩请求一到两个、都经模型池（上表第 23 条） | `--only compaction` 七条全部通过（单独重跑时照样失败过一次） |
| `tb-app-modes` | TB-56、TB-08 | 不是计时：`transcriptItems` 取你的消息的文字时连带了第 2 步加的 `Rewind` 按钮（`Message ARewind`），实时与重新打开后不一致 | 测试：`tb-helpers.mjs` 的 `transcriptItems` 去掉 `.user-actions` 再取文字 | `--only once,switching,decide,error,queueThree,withdrawStep,heldStep,command,commandHeld,template,mergedReceipts,restart` 42 条全部通过（第一次单独重跑时 TB-56、TB-08 照样失败） |

`tb-helpers.mjs` 的 `transcriptItems` 也给 tb-app-flow、tb-app-handoff、tb-app-stop、tb-replay 用，它们这次没有跑（只去掉按钮的文字，推送前的完整测试会跑到）。

**`test:fs-unit` 的时长**（§19.1 要求 ≤ 20 秒；这台机器同时有别的会话的 App 套件、Telegram、ToDesk 与杀毒软件在跑，每次先记下跑之前 3 秒的整机负载）：

- 交接时约 34 秒。这台机器上起点：175 条失败（10 秒，见上面的环境）；只修找 git 之后 PowerShell 里 32.1、35.5 秒，带计时的几次 23.8–28.2 秒。
- 量出来的瓶颈：整组跑时 CPU 一直是 100%；起了约 1440 个 git 进程（内核按规格每张快照 8–10 个，测试自己约 120 个），本机起 git 进程最快每秒
  120–138 个，光起进程就要 11 秒左右；每个文件单独跑的时长加起来 63.5 秒。
- 做了的（用例与断言不变）：`real-git.mjs` 按 PATH 找到启动器旁边真正的 git，`status.test.mjs` 与 `git-helpers.mjs` 准备数据也用它（不再一次起两个进程）；
  FS-02 的过滤器改为长期运行的过滤器、用 `read -t` 等，不再空转占一个核（原来整组里 sh 占了约 13 核·秒）；FS-02 的三条进程树用例分到
  `git-tree.test.mjs`，要等的 6 秒超时与别的文件同时过，收拾时按过滤器写下的进程号结束它，不再起两次 Windows PowerShell；
  内核模块的打包结果不写盘（`tests/unit/load.mjs` 的 `bundleInMemory`，`registerHooks` 从内存交给加载器），写盘再导入时杀毒软件先扫一遍新写的脚本，
  本机实测 30 个 300 KB 的包写盘要 2.2 秒、内存里 0.3 秒。
- 之后：每个文件单独跑的时长加起来 51.6 秒；整组在负载 17–28% 时 23.4、24.3、23.6、25.9 秒；负载更高时（别的会话的 App 套件、Telegram、ToDesk）
  32–61 秒，44 秒与 61 秒那两次 FS-49（1 MB 命令 ≤ 500 毫秒）超时。**没达到 ≤ 20 秒**：剩下的主要是内核按规格起的 git 进程（每张快照的步骤、
  §3.4“不缓存”的 `repoInfo`、一轮结束后的读），再快要么改内核的调用（规格外），要么让 snapshots、runs、rewind、worktree 的用例共用更多场景
  （要改用例的写法，这次没做），等负责人定。

**`npm run test:min`**：通过，127.8 秒（开始前整机负载 50%）；`test:unit` 422/422、`test:tb-unit` 353/353、`test:mem-unit` 226/226、`test:md-unit` 197/197、
`test:fs-unit` 958/958。

## 开工前核对：§6.1 引用的 mori-team、mori-memory 行为

核对日期 2026-10-26，基准 HEAD `8004ddd`，pi-coding-agent 1.3.0。方法是读代码；扩展顺序另用与 Mori 相同的 `DefaultResourceLoader` 写法实测一次（脚本在 scratchpad，不进仓库）。

**结论**

- mori-team、mori-memory 的拒绝行为与平行 Agent 规格（§7.1、§7.5、§14.3、§14.6）、记忆规格（§7.7、§9.6）一致；§6.1“它们先拒绝的调用不到路径闸”成立。
- 扩展的运行顺序与 §6.1 的写法不同：`mcp` 带 `builtin: true`，pi 把它从 inline 列表拆出、作为扩展路径 `builtin:mcp` 放在所有 inline 扩展之前
  （`dist/core/resource-loader.js:249-251`、`:565-571`，`dist/core/package-manager.js:737-743`）。实测顺序：`builtin:mcp`、`<inline:mori-models>`、
  `<inline:mori-team>`、`<inline:mori-memory>`、`<inline:mori-approval>`；`<agentDir>/extensions` 里的扩展排在 `builtin:mcp` 之前。
  所以 `mori-approval` 是**最后一个** `tool_call` 处理器：它拿到的 `event.input` 已是前面所有扩展改过的最终参数，之后也没有处理器再改。
  mcp 的 `tool_call`（`dist/extensions/mcp/index.js:1049-1071`）只等服务器就绪、从不拒绝，所以判断顺序不受影响。
- 路径闸的判断顺序不用改。

| # | §6.1 的说法 | 代码（HEAD） | 与规格 |
| --- | --- | --- | --- |
| 1 | 扩展顺序 mori-models、mori-team、mori-memory、mori-approval、mcp | `app/src/kernel/sessions.ts:315-317` 的数组按这个顺序；运行时 `builtin:mcp` 在最前（见上） | 部分不符：四个 inline 的相对顺序对；“mcp 在最后”不对（平行 Agent §8.2、§14.3，记忆 §5.3 与三处代码注释同） |
| 2 | pi 按顺序调处理器，第一个 block 生效 | `dist/core/extensions/runner.js:957-972` 逐个 `await`，遇到 `block` 立即返回；kernel 里注册 `tool_call` 的只有 approval、memoryExtension、teamExtension | 符合 |
| 3 | mori-team：交接之后拒绝 | `executeTaskHandoff` 成功后设 `lane.run.handedOff`（`teamTools.ts:285-291`），`guardToolCall`（`boardTools.ts:421-423`）对任何工具拒绝 `You handed off <task>; stop here.`，带 `terminate` | 符合平行 Agent §7.1、§14.3、§14.6 T-F6 |
| 4 | mori-team：强制填写 | 工具名不是 `form.tool` 时拒绝 `Only <tool> works in this turn; call it now.`（`boardTools.ts:424-426`），带 `terminate` | 符合 §7.5 第 1 步 |
| 5 | mori-team：对话的工具限制 | `team.ts:1520-1524`：协作模式 `RELAY_ONLY`，关闭模式 `<tool> is not one of <role>'s tools.` | 符合平行 Agent §5.5；两句都由第 3 步的收窄代替（§8.6） |
| 6 | mori-memory：记忆目录写保护 | `memoryExtension.ts:192-199` `guardWrite` 只看 `write`、`edit` 的 `path`，按词法判断 | 符合记忆 §7.7 |
| 7 | mori-memory：增强运行里的 write、edit | `memoryExtension.ts:195` 一律拒绝 `Enhancement runs can only change memory, with the memory tool.`，实例同样带入 | 符合记忆 §9.6 |
| 8 | 前两者不改参数 | `guardCall` 只读工具名，`guardWrite` 只读 `input.path`；pi 交给处理器的参数与执行用的是同一个对象（`agent-loop.js:491-499`、`526-531`） | — |

**对路径闸的影响**

1. 预告不知道 mori-team、mori-memory 会先拒绝：被它们拒绝的调用，工具卡先按路径闸的预告显示，再以 `isError` 结束（现在已是这样）。
   §6.15 的 `DENIAL_PREFIXES` 没收这几句，所以它们显示 `Failed` 加预告的标签，而收窄、没人能批的拒绝显示 `Denied`。是否把它们加进表里，见下面“待负责人定”。
2. mori-memory 只按词法判断：工作路径里指向记忆目录的链接能绕过它；到了路径闸按真实路径归 `outside`，会出卡。推荐记为已知限制，不另加机制。
3. 规格引用的小更正（设计不变）：§6.1 的 `sessions.ts:293-308` 实为 `:298-317`；处理器抛 `Error` 时 pi 原样再抛，由 `agent-loop.js:533-538` 变成以 `error.message`
   为原文的错误结果，只有非 `Error` 的抛出值才带 `Extension failed, blocking execution:` 前缀，两种情况工具都不执行，所以“分类出错时自己接住”不变。

## 负责人不在时定下的选择（2026-10-27 起，待负责人复核）

负责人 2026-10-27 说“无人开发模式，有问题按照推荐解决，我明天过来审视你的决定”。下面每一条都按推荐做法定下，规格里注
“（2026-10-27 注：负责人不在时按推荐定，待复核）”或在临时默认值里登记。

| # | 问题 | 选项 | 选了 | 理由 | 改了哪些文件和条目 |
| --- | --- | --- | --- | --- | --- |
| 1 | 算术里的命令替换：§7.3 只说 `$((…))` 的内容不分析；审查后实现也分析 `((…))` 与 `for ((…))` 里的 `$(…)`，而我先前登记的 §17 一行把三种都写成“不分析” | A 照实现：`$((…))` 不分析，`((…))`、`for ((…))` 照常分析；B 三种都不分析（改实现） | A | bash 会执行 `((…))` 里的命令替换，分析它们只会多问、不会漏；§7.3 的原文只管 `$((…))`，那一行是我写错的临时默认值 | 规格 §17 与 defaults.md 的“算术里的命令替换”一行；`tests/unit/filesystem/scan-bash.test.mjs` 的 FS-44 一条 |
| 2 | 会话引用里的 `[Mori]` 投递（§5.3、session-refs.md、ui-strings.md 写“`User:` 几行接到前一轮里，内容不丢”）：实现时发现 `session.read` 本来就不交投递的消息与 `mori.wake` 条目（平行 Agent 规格 §13.11，`entries.ts` `quotableEntries`），规格以为它们现在单算一轮 | A 照旧不交：编号已与 `turnNumbers` 一致，模型看到的引用文字不变；B 改 `session.read` 交出投递、把 `User:` 几行接到前一轮（引用文字变，要重录 m5 fixture，并改平行 Agent §13.11） | A | §5.3 要的是两处编号一致，A 已做到；“内容不丢”是怕改编号时丢内容，而内容本来就不在引用里；B 推翻平行 Agent 定过的“投递不是你说的话” | 规格 §5.3、§17“轮的编号”、§18 session-refs 一行；`docs/v0/screens/session-refs.md`、`docs/v0/ui-strings.md`、defaults.md 注明 |
| 3 | 很长的工作路径：内部仓库的路径 = 快照目录 + `projectDirName` 编码，git 2.55 拒绝过长的 `--git-dir`（实测 `'$GIT_DIR' too big`、`Filename too long`，`core.longpaths` 也不行），工作路径约 190 个字符以上就拍不了快照 | A 记为已知限制，`snapshots.error` 显示 git 的原文，git 状态照常；B 内部仓库目录改用短的散列名（改 §4.1 与 FS-06 的“编码同 projectDirName”） | A | 规格明确要求与 pi 会话目录同一种编码（FS-06 验收）；这么长的路径少见，Windows 上许多工具在 MAX_PATH 附近同样出错；失败有原文，不会恢复错 | 规格 §0 已知限制一条 |
| 4 | Rewind / Undo 进行中关闭、归档、删除会话或点 Check again：规格没写，审查发现关闭会释放 pi 会话，恢复到一半时会写进已删掉或重开的会话文件 | A 拒绝，用 §5.10 已有的 `This session is already rewinding.`，界面先在本地拒绝、Check again 不可用；B 用 `This session is still running. Stop it first.`（Rewind 停不了，会误导）；C 另造一句 | A | 不另造文字；不会用到已释放的会话 | `kernel/sessionWorkspace.ts`、`sessions.ts` 的两处调用、`state/projects.ts`、`BlockedCard.tsx`；规格 §17 与 defaults.md 一行 |
| 5 | 规格没给原文的三种 Rewind 情况：两项都没选；扩展让 pi 取消移动对话；恢复文件之后的快照 Q 失败 | A `Choose code, conversation or both to restore.`；`An extension cancelled moving the conversation.`（已恢复代码时包进 `Couldn’t restore the conversation: …`）；Q 失败时照样写记录（`post: null`）、提示 `Couldn’t take a snapshot: <原文>`、这次没有 Undo。B 不写记录 | A | 文件已经恢复，不能当没发生；没有 Q 时 Undo 分不出之后的改动，前后端都不提供 | `kernel/rewind.ts`、`state/rewind.ts`；规格 §17 与 defaults.md 三行 |
| 6 | 三个及以上需求还开着时的列表写法（规格只给了两个的 `Requests 1 and 3 …`） | A 牛津逗号 `Requests 1, 2, and 3 …`；B `1, 2 and 3` | A | docs/v0/ui-strings.md 的写法约定；内核与菜单的一行用同一种 | `kernel/rewind.ts`、`state/rewind.ts`；规格 §17 与 defaults.md 一行 |
| 7 | §4.2 写内部仓库的每个 git 进程 cwd 都是工作路径；§4.7 又要求工作路径已经不在时（worktree 先删、文件夹被你删了）删除会话照样能整理 | A 只动 ref 与对象的 `for-each-ref`、`update-ref`、`prune` 用内部仓库的目录为 cwd，其余照 §4.2；B 照 §4.2，工作路径不在时不整理 | A | 这三个命令不用工作树；B 会让删掉的 worktree 会话留下快照 | `kernel/snapshots.ts`；规格 §4.2 注明，§17 与 defaults.md 一行 |
| 8 | 实现时补的几个临时默认值：没有 `LOCALAPPDATA` 时的快照目录；结束 git 之后输出一直不关；第一份 git 状态到之前界面怎样 | A `<主目录>\AppData\Local\Mori\snapshots` 并记日志；再等 2 秒按被结束算（退出码 null）、记日志；不显示 Rewind、Undo 与 `+N −M`。B 分别为报错不启动、等到超时、先按可用显示 | A | 都是不会恢复错、不会把半截输出当成功、不会在没装 git 的机器上闪一下的做法 | `main/kernel-process.ts`、`kernel/git.ts`、`state/workspace.ts`；规格 §17 与 defaults.md 三行；`fs-changes.md` 补 `changes-loading`、`git-empty`、`git-footer` 三个标识 |
| 9 | 审查发现 §5.7 第 3 步的 `git restore --worktree` 会删掉挡在恢复路径上的整个目录与文件（文件后来变成了目录、上级目录变成了文件或联接），里面可能有没记下的内容 | A 恢复前逐个检查：上级是文件、链接或联接时不恢复（`A file is in the way.`），位置上是有内容的目录时不动（`A folder is in the way.`），只有空目录时逐层 `rmdir` 再恢复，都进 `failed`；B 照规格让 git 删 | A | proposal 说恢复只动这个会话记下的文件；A 仍能把“文件变成空目录”的常见情况恢复回来 | `kernel/rewind.ts`；规格 §5.7 第 3 步注明，§17 与 defaults.md 一行 |
| 10 | 审查发现 §5.9 第 2 步的 U = `diff(safety, post)` 含恢复期间（P→Q）别的会话改的文件，Undo 会把它们悄悄改回去 | A U 与那次恢复的集合取交（列表没列全时按那次用的分支重算），说不准的按 `overlap` 冲突问你；B 照规格 | A | §5.7 第 4 步把 P→Q 里其余的文件记给别的会话，Undo 不该动它们 | `kernel/rewind.ts`；规格 §5.9 第 2 步注明，§17 与 defaults.md 一行 |
| 11 | 审查发现的三处与规格写法不同的修正：结束 git 只结束 `cmd\git.exe` 启动器（真正的 git 拿着锁继续跑）；内部仓库建到一半被停止或结束后永远坏掉（留下 `config.lock`、缺 `info/attributes`）；关闭、删除会话后晚到的结束快照把删掉的会话文件重新建出来 | A 结束整棵进程树（`taskkill /F /T`，起不来时退回 `child.kill()`）；没有 `HEAD` 时删掉半建的目录重建、每个进程第一次核对 `info/attributes`；关闭时等这个会话自己的结束快照、会话文件不在时不写记录。B 照规格原文 | A | 都是规格原文会导致锁死、换行被转换或数据错乱的情况 | `kernel/git.ts`、`kernel/snapshots.ts`、`kernel/sessionWorkspace.ts`、`sessions.ts` 一处调用；规格 §3.3、§4.1 注明，§17 与 defaults.md 两行 |
| 12 | 测试发现 §4.3 的推理不成立：内部仓库的 `add -A` 自己读工作树里的 `.gitignore`，你用 `git add -f` 跟踪、又匹配忽略规则的文件（FS-07）从不进快照 | A 有仓库时每张快照前问你的 git `ls-files --cached --ignored --exclude-standard`，把还在磁盘上的用 `add -f` 分批加进内部仓库；B 照旧不收（改 FS-07） | A | FS-07 与 git status 一致的要求；多一个 git 进程，只在有这类文件时多一批 add | `kernel/snapshots.ts`；规格 §4.3 注明 |
| 13 | 测试发现 `test:fs-unit` 在 PowerShell 里跑要 42–49 秒（§19.1 要求 ≤ 20 秒）：真实 git 的用例一起起上千个 git 进程，PowerShell 的 PATH 里只有 Git for Windows 的启动器 `cmd\git.exe`，每次调用两个进程，本机每秒最多起约 74 个 | A 内部仓库的调用直接起启动器旁边真正的 git（你的仓库的调用不变），测试准备数据与场景测试也用真正的 git（测启动器本身的用例除外）；B 只改测试；C 放宽 20 秒 | A | 每轮运行前后的快照少一半进程，界面上的 Taking a snapshot… 更短；测试两种 shell 里一样快 | `kernel/git.ts`；`tests/unit/filesystem/real-git.mjs`（新）、`snap-helpers.mjs`、`runs-helpers.mjs`、`rewind-helpers.mjs`、`git.test.mjs`；规格 §3.3 注明，§17 与 defaults.md 一行 |
| 14 | 结束 git 后等 `close` 的 2 秒宽限原来从调用 taskkill 时算：整组测试并行、机器忙时 taskkill 自己就要一两秒，宽限先到，记一行 `its output stayed open` 并把结果当成管道没关 | A 宽限从 taskkill 退出时算（最多等 10 秒）；B 宽限放长 | A | 宽限要量的是“进程树结束之后管道还开着”，日志原文就是这样说的 | `kernel/git.ts`；规格 §3.3 注明，§17 与 defaults.md 一行 |
| 15 | 做了第 13、14 条之后 `test:fs-unit` 在 PowerShell 里连续四次 20.6–20.9 秒，比 §19.1 的 20 秒多 0.7 秒左右；`test:min` 整套 97 秒（≤ 2 分钟） | A 照实记下，不再删真实 git 的用例；B 删减用例凑进 20 秒 | A | 20 秒是为了让 `test:min` 留在 2 分钟内，这一条成立；关键路径是 FS-26 嵌套仓库那一串（四十多个依次起的 git 进程），再删就少了验收要的场景 | 本文件“状态”一节 |
| 16 | 会话的文件夹本身是指进仓库子文件夹的目录联接或 subst 盘时，按 §11.2 从 cwd 的写法推出的 R 与 `<sub>` 指到仓库外面 | A 比对真实路径，对不上就拒绝，原文 `This folder’s path doesn’t lead to its repository root <toplevel>, so Mori can’t place a worktree here.`，什么都不改；B 改用 git 给的仓库根（侧栏分组与记忆目录名会和主文件夹对不上）；C 不查（worktree 建到仓库外面） | A | 不破坏“R 从 cwd 的写法推出”这条规则，也不会建错地方 | `kernel/workspace.ts`；规格 §17 与 defaults.md 一行，fs-worktree.md“失败的原因” |
| 17 | 建 worktree 超时的原文（规格只给了恢复 worktree 超时的原文） | A `timed out after 120 seconds`（快的步骤 `timed out after 10 seconds`），界面前加 `Couldn’t create the worktree: `；B git 的原文 | A | 同 Initialize git 的写法；超时时 git 没有原文 | 同上 |
| 18 | 规格与屏幕表没写的几处界面行为：Storage 里读不出改动的项写什么；删除确认框几种 worktree 写法同时成立时取哪句；建 worktree 中归档、删除；Storage 清理命令本身失败；后台进程不可用时右栏的 Initialize git… | A 依次为：不写改动标签；正被使用 → 没装 git → 读不出 → 有改动 → 干净；拒绝并用 §11.5.6 的原文；每项都列 `Couldn’t delete <branch>: <原因>` 再读一次；不显示（同输入框下一行的入口）。B 另造文字 | A | 都用规格已有的原文，不造新句子 | `StorageSection.tsx`、`state/worktrees.ts`、`state/projects.ts`、`ChangesPanel.tsx`；规格 §17 与 defaults.md 各一行 |
| 19 | 还没保存的 worktree 会话（第一条消息没能写进会话）按拒绝启动卡的 Check again：重建出来的会话没有 `mori.worktree`，就不再拥有那个 worktree | A 重建时把原来的条目写进新的 SessionManager（仍只有一条）；B 照现在丢掉 | A | §11.6：只有拥有它的会话在归档、删除时处理它；丢掉就会留下没人管的 worktree | `kernel/worktreeSession.ts`、`sessions.ts` 一处调用；规格 §17 与 defaults.md 一行 |
| 20 | 两个已知的限制：§8.6 拒绝打开的旧会话在检查之前已被 pi 与选择范围的载入写了条目；`git worktree remove --force --force` 中途失败时 git 删了登记、文件夹留着 | A 记为已知的限制；B 为前者改 pi 的建立顺序（pi 自己写，sessions.ts 只许加调用）、为后者另做恢复 | A | 前者会话照样打不开、数据不丢；后者是 git 的行为，原文已告诉你怎么办 | 规格 §0“已知的限制”两条 |
| 21 | 审查发现归档（`worktrees.cleanUp` 不带 force）读不出 worktree 的改动时把它当干净删掉；`status.showUntrackedFiles=no` 时没跟踪的文件也被当成干净 | A 读不出就不删、`error` 为 git 的原文，读改动加 `-c status.showUntrackedFiles=normal`；B 照旧 | A | 归档不问你，删错了就丢了没提交的文件 | `kernel/workspace.ts`；规格 §11.9.1 第 4 步注明，§17 与 defaults.md 一行 |
| 22 | 修 tb-app-misc 时发现（下面“已知失败的修复”）：协作模式分开时立项在对话写下你的消息之前就判断、派出 task，task 改文件的那一段落在会话里还没有你的消息的时候，§4.5 原文“找不到 → 这一段不记给这个会话”把它丢掉，违反 FS-11、FS-14（右栏不自动打开、README.md 没有 `executor (T1)`） | A 这一段先留着（只在内存里），记进之后写下的第一条你的消息（多半就是派出它的那条），那时的叶子已不在当前分支上（恢复了对话）时丢掉；B 照原文丢掉，改测试让 task 晚一点改文件；C 让 Team 把待判断的消息告诉快照模块，判断期间的段都记给它 | A | 只改“找不到”的那一支，别的轮照旧按写下的时刻算（与 Rewind 用的运行开始的快照一致）；B 掩盖真实的竞态（真实模型下 task 也可能先改）；C 要新接线，第二条及以后的消息也改归属 | `kernel/timeline.ts`（`HeldChanges`、`releaseHeld`）；`tests/unit/filesystem/timeline.test.mjs` 两条 FS-11；规格 §4.5 注明，§17 与 defaults.md 一行 |
| 23 | 修 v1-models-app-session 的 MP-22 时发现：每轮之后有 Mori 的元数据条目（`mori.turn_changes`）时，pi 找压缩切点会把紧挨着的元数据条目一起留下，切点落在元数据条目上就当成“拆开的一轮”，多做一个 turn prefix 摘要（溢出恢复时日志为 400、200、200、200，原断言写死 400、200、200） | A 照 pi（不改 pi、不挂压缩钩子），MP-22 的检查改为一到两个压缩请求、都经模型池；B 在 mori-models 里接 `session_before_compact` 改切点 | A | MP-22 的验收只要求压缩经模型池、用当前模型和 key、出错不换模型，没规定请求数；B 是规格外的机制。代价是这种情况下多一次压缩请求，摘要里多一段 “Turn Context (split turn)” | `tests/ui/v1-models-app-session.mjs`；defaults.md 一行 |

## 交互细节照 Claude 桌面版

规格与屏幕表没写、实现时照 Claude 桌面版定的。第 1 步：

- 提问卡：卡头与每个问题上方是 header 标签；每个选项一行（输入、label 与 ` (Recommended)`、下面次要文字的 description）；所有问题在一张卡上，最下面一个 Submit。
- Submit 是与其他卡按钮相同的次要按钮（不设主按钮或默认按钮）；没答完时 `aria-disabled`、50% 不透明度，仍可聚焦。
- 提问卡的读屏名 `Waiting for your answer: <各 header 用 ", " 连接>`（同批准卡的 `Waiting for your approval: …`）；Other 输入框的读屏名 `Other answer for <header>`。
- 问题组里的键盘：左右方向键同上下、循环；方向键只移动焦点不选中（单选也是），Space 选中；每组一个 Tab 停靠点（roving tabindex），停在上次聚焦的项。
- 单选题选了选项就丢掉 Other 里的文字；多选题取消 Other 也丢掉它的文字。
- 提问卡上没提交的选择按栏保存在内存里：卡让位给批准卡再回来时还在，重新载入后没有；恢复出来的 Other 输入框不抢焦点，新选中 Other 时才移焦点。
- 倒计时一行不是 `aria-live`（免得每秒播报一次），用较深的 `--color-warn-text` 保证 12px 的对比度；原因行保持 v0 的警示色。
- “Decided while you were away” 是对话流里带边框的一块：标题、说明行、每条记录一行（时间靠右）；每行的读屏名是可见文字（` · ` 换成 `, `）加时间；整块不参与选区引用（`data-no-quote`）。
- 提问的 header 还没流式写完时，工具卡标题为 `Ask · …`。
- 权限菜单里的 `Writes to <目录>` 在原有 220px 宽的菜单里换行显示全路径，菜单宽度不变。
- 批准卡第二个按钮与小字里的长路径在任意字符处换行（`overflow-wrap: anywhere`），窄栏里按钮不比卡宽。
- 设置页 General：左边名字、右边下拉框（同 Models > Defaults 的排法），说明作为下面的提示；保存中下拉框不禁用（保住键盘焦点），保存中再选一次被忽略。
- 卡没有第二个按钮时小字一行也不显示，按钮行加下边距。
- 扩展询问卡也排在后台实例的批准卡之后（规格：批准卡，不论对话的还是后台的，先显示）；扩展询问卡的 `{n} more` 同样带 `data-testid="approval-more"`。

第 2 步：

- 你的消息下面一行靠右的 `Rewind` 文字按钮（同 Claude 桌面版消息下方的操作）：平时透明、仍在 Tab 顺序里，悬停这条消息、焦点进入或菜单开着时显示，位置预留、不跳动。
- Rewind 菜单挂在 body 上、固定定位：在按钮下方右对齐，下方放不下时翻到上方，滚动、改尺寸时跟着；焦点从第一个可选项开始，Tab 关闭菜单回到 `Rewind`；
  点外面关闭不记动作，只有 `Never mind` 与 Esc 记 `Rewind: Never mind`；不可选的 `No code restore` 是淡色、不可聚焦的一行；需求还开着的一行在最后，菜单的 `aria-describedby` 指向它。
- 冲突对话框：按钮顺序 Overwrite / Skip these files / Cancel，Overwrite 用黄色警示（有 Undo，不用红色）；宽 min(520px, 100%)，列表 240px 处滚动；
  第二次调用进行中三个按钮 `disabled`、焦点移到对话框本身（Tab 与 Esc 仍困在里面），关闭后焦点回到打开前的元素。
- Rewind / Undo 做完、那条消息不在了时，焦点到输入框（文字放回到那里，同 Claude 桌面版光标在输入框里）。
- Refresh 是带悬停 `Refresh` 的图标按钮，刷新中图标换成转圈、`aria-disabled`（焦点留在它上面）。
- git 状态与 This session 的路径用等宽字、一行、超长省略、悬停看全路径（同 Claude 桌面版的文件列表）；冲突列表里的路径换行。
- 加减行数的颜色：新加的令牌 `--color-added` #1f7a58、`--color-removed` #b84444，在白底上 12px 字对比度都是 5.3:1；状态字母 A 绿、D 红、M/R/C/T 琥珀色、U 危险色。
- `+N −M` 只有读屏名、没有悬停说明（规格没给）；会话面板 ≤ 600px 时用容器查询隐藏。

第 3 步：

- Worktree 开关宽时是 `branch` 图标加 `Worktree` 两个字、窄时（≤ 460px）只有图标，`Initialize git…` 用同一种圆角胶囊样式与图标（同 Claude 桌面版输入框下一行的开关）；
  打开时用强调色的浅底与深字。宽时悬停只有说明，窄时悬停先写名字再写说明。
- 侧栏会话行的分支标签用次要文字色，挤的时候先缩它（最少 24px），会话名留得住；状态仍在最右。
- Initialize git、删除与 Storage 清理的确认框共用一个外壳（`InitGitDialog.tsx` 的 `WorktreeDialog`），关闭后焦点回到打开前的元素，没有了就回到这一栏的输入框；
  Initialize git 的确认按钮是主按钮，Clean up 用危险色。
- 删除确认框在 `worktrees.list` 返回之前写 `Checking its worktree…`（`role="status"`，换成那一句时读屏会读出），`Delete` 为 `aria-disabled`。
- Storage 清理之后焦点回到 `Clean up worktrees…`（还在、可用时），否则回到 `Worktrees` 标题。

## 负责人的决定（第 1 步）

2026-10-26 经规划会话问负责人，2026-10-27 定下，已在规格里注明“（2026-10-27 注：负责人定）”，§17 与 defaults.md 同步：

1. MEM-01 规定默认工具下身份段 ≤ 500 token；加上 §14 的 `.work` 一行后 Ask each time 为 523 token。负责人定：上限改为 2000 token
   （“change to 2000”），`.work` 一行与权限句照 §14 原文不缩（记忆规格 §4 与 MEM-01、file-system.md §14 已注明）。
2. FS-49“1 MB 的命令一次分析 ≤ 200 ms”：实测多数形状 165–250 ms，最坏约 470 ms。负责人定：命令长度上限仍是 1,000,000 字符，FS-49 改为 ≤ 500 ms。
3. §7.4 写 eval / Invoke-Expression 里的 `cd` 不影响外面；真实的 bash、pwsh 会影响。负责人定：照真实 shell，eval、iex 里的 `cd` 延续到后面，
   `bash -c` / `pwsh -c` 仍隔开。
4. §7.2 的 leave 去重键缺 `dir`，会去掉换到别处的第二次 leave。负责人定：键里加上 `dir`。

5. mori-team、mori-memory 先于路径闸的拒绝（上面“对路径闸的影响”第 1 条）：负责人定统一显示 Denied：交接后（`You handed off ` 按开头）、
   强制填写（两句整句）、记忆目录写保护与增强会话的 write、edit 两句加进 `DENIAL_PREFIXES`（`shared/workspace.ts` 的 `TEAM_MEMORY_DENIALS`），
   工具卡显示 `Denied · <原文>` 并去掉预告的放行标签；规格 §6.15、§12、FS-38 与 fs-permissions.md 已注明。
7. 按目录放行与工作路径里的写入（审查时发现）：Ask each time 下 `cp a.txt ../out/ && rm -rf src` 在 `../out` 被放行后，按 §6.1 第 3 步原文会整条不问，
   连工作路径里的 `rm -rf src` 也不问。负责人定（A）：Ask each time 下这样的调用按 scope `inside` 到第 4 步（出卡，可按工具名放行），只写外面的照常按目录放行，
   Full access 下不变；规格 §6.1、§6.9、FS-32 与 fs-permissions.md 已注明，`approval.ts` 的 `effective` 实现。
6. 工作路径里指向记忆目录的链接绕过 mori-memory 的词法判断：负责人定记为已知限制（规格 §0），不加机制，路径闸照常按外面出卡。

另外命令分析实现时补了几个规格没给的资源上限（结果 1000 条、pushd 栈 1000 层、路径 32,767 个字符、路径总工作量 64,000,000 个字符），
以及嵌套层数也计入包装命令、函数体、coproc 与 PowerShell 赋值的右边，按临时默认值登记在 §17 与 defaults.md（负责人同意照登记）。

## 补写的 App 套件与回放 fixture（2026-10-27，`wt/fs-suites`）

交接 issue #3 “没写”的三项，在 `wt/fs-suites`（从 `claude/happy-bell-a93948` 的 `6470920` 切出）上补齐。没改 `src`，也没改合成端点的脚本
（`scenarios/fs-team.mjs`、`fs-worktree.mjs` 在第 3 步已为这两个套件写好）。

### 加了什么

- `tests/ui/fs-app-team.mjs` 与 `fs-team-helpers.mjs`（新）：FS-57、59–62、65、66、68 的 App 层，12 个步骤：
  `splitLimits`（FS-57、60：分开的配置，三个 task、临时提问、立项、结案、订阅、对话各自的收窄，agent_message.limits 发到 task 与进座位
  会话时不用；各种实例请求里的工具）、`offAsk`（FS-57、60：关闭模式的主 Agent 与它发起的提问）、`mergedMode`（FS-57：合并会话、运行开始时的
  模式）、`beforeApproval`（FS-59）、`switching`、`lateMcp`（FS-60）、`roleTools`（FS-61）、`writeLock`（FS-62）、`enhanceIdle`、
  `enhanceRunning`、`enhanceTeam`（FS-66）、`reopen`（重新启动一次：FS-60 载入的一半、FS-65、FS-68）。
- `tests/ui/fs-app-worktree.mjs` 与 `fs-worktree-helpers.mjs`（新）：FS-98–107、109–112 的 App 层，25 个步骤（`storageEmpty` 到 `noGit`，
  最后两步各重新启动一次 App，`noGit` 用 `MORI_GIT_PATH` 指到不存在的 git，§19.1）。只在单元层的条件（FS-100 的 `startInWorktree`、
  FS-106 的 `state/worktrees.ts`、FS-109 直接调 `initGit`）不在这里。
- `tests/fixtures/filesystem/`（新）：`work-scratch.json`、`full-outside.json`、`away-reminder.json`，都是真实录制（下一节）；
  `fs-replay.mjs` 里 FS-36、FS-54、FS-78 的检查原来就写好了，只缺 fixture，没改。
- `tests/ui/fs-helpers.mjs` 的 `FS_PORTS`：team、worktree 改用 4980–4983（app-v0 上别的套件已占 4950–4979，defaults.md 一行）。
- `docs/v1/defaults.md` 末尾“§19 验收：补写的 App 套件”四行（端口、验计时的做法、FS-68 的 `defaultTools` 写在项目层、测试用的 `HOME`）。

### 录回放 fixture（真实层，没用 key 方式）

- 命令：`node tests/ui/fs-real.mjs --source <数据目录> --only work-scratch,full-outside,away-reminder`。
- 第一次直接用给的 `%TEMP%\mori-real-data`：三步都失败。那个目录的 `model-config.json` 已是 app-v0 去掉网络区域之后的格式（提供商没有
  `zone`，没有 `allowedZones`、`projectZones`），这个分支的 Mori 读不出（`providers.0.zone: Invalid option …`），探针等满 15 分钟，各步在
  授权公网时报错。
- 第二次：把 fs-real 要用的五个文件（加密的 `credentials.json`、`Local State`、`model-config.json`、`model-profiles.json`、
  `pi/settings.json`）复制到另一个临时目录（没有打开 `credentials.json`），只改 `model-config.json`：两个提供商加 `zone: "public"`，
  加 `allowedZones: ["local", "intranet"]` 与 `projectZones: {}`（这个分支的格式），用它作 `--source`。三步 19 条检查全部通过
  （`fs-partial-real.json`，FS-54 6 条、FS-82 3 条、FS-114 10 条），fixture 写到 `tests/fixtures/filesystem/`（`source: real`，
  DeepSeek `deepseek-flash`）。之后删了这份副本（先删 `credentials.json`）和两次运行留下的数据目录；fixture 里扫过 `sk-`、`Bearer`、
  `x-api-key`、`authorization`，没有。合并进 app-v0（没有区域）之后不再需要这一步改写。

### 运行结果

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| fs-app-team | `node tests/ui/fs-app-team.mjs`（整套） | 50/50 通过，没有 known；5 分 36 秒 |
| fs-app-worktree | `node tests/ui/fs-app-worktree.mjs`（整套，两次） | 103/103 通过，没有 known；第二次（交付前重跑）6 分 35 秒 |
| fs-replay | `node tests/ui/fs-replay.mjs --only full-outside,work-scratch,away-reminder` | 9/9 通过（FS-36、FS-54、FS-78 各 3 条，`fs-partial-replay.json`） |
| fs-real | 上一节 | 19/19 通过（`fs-partial-real.json`） |
| `npm run test:min` | 每次改动的最小集 | 检查、构建、`test:unit` 422/422（含 MP-38 md-markers）、`test:tb-unit` 353/353、`test:mem-unit` 226/226、`test:md-unit` 197/197 通过；`test:fs-unit` 781/956 失败，见下 |

- `test:fs-unit` 的 175 条失败与这次的改动无关（单元测试不 import 改过或新加的文件）：本机的 Git for Windows 装在 `D:\Git`，
  `tests/unit/filesystem/real-git.mjs` 只认 `C:\Program Files\Git`，找不到时把候选设为空，用真实 git 的用例全都得到 “Git is required …”。
  `wt/fs-fixes` 的 `e76398a`（test:fs-unit: find the real git from PATH）已经改了这里；那是它的文件范围，这里没动。
- 每个编号各有一条 “(fs-app-<套件>) the page reported no errors”，都通过（算在上表里）。

| 编号 | fs-app-team 通过 | 编号 | fs-app-worktree 通过 |
| --- | --- | --- | --- |
| FS-57 | 13 | FS-98 | 14 |
| FS-59 | 6 | FS-99 | 10 |
| FS-60 | 9 | FS-100 | 5 |
| FS-61 | 3 | FS-101 | 5 |
| FS-62 | 3 | FS-102 | 9 |
| FS-65 | 4 | FS-103 | 3 |
| FS-66 | 8 | FS-104 | 5 |
| FS-68 | 4 | FS-105 | 11 |
| | | FS-106 | 9 |
| | | FS-107 | 9 |
| | | FS-109 | 13 |
| | | FS-110 | 3 |
| | | FS-111 | 3 |
| | | FS-112 | 4 |

**覆盖检查**：`node tests/spec-coverage.mjs --spec filesystem --allow-missing-real` 里这 22 个编号的 App 层都有通过的结果。FS-36、FS-54、
FS-78 的回放层按测试分层只跑了 `--only`（`fs-partial-*` 不算），推送前整套跑 `fs-replay.mjs` 才算进去；临时把
`fs-partial-replay.json` 复制成 `fs-replay.json` 看过：三个编号的回放层都是 “ok 3”，看完删了副本。其余缺口是单元层（上面的
`test:fs-unit`）和这个包没跑的套件。

**app-v0 的 `tests/unit/spec-ids.test.mjs`**（这个分支还没有它；临时复制进来跑了一次，跑完删掉）：文件系统一份没有 App 层、回放层的缺口，
没有以 FS 编号命名却写死通过的检查出自这两个套件。它报的三件事都不在这个包的范围，留给合并的人：
1. `no node --test command runs tests/unit/<dir>*.test.mjs writing fs-unit.json`：`tests/unit/fs-reporter.mjs` 写的是
   `createReporter('fs-unit.json', true)`，spec-ids 找的是 `createReporter('fs-unit.json')`，所以 71 个单元层条目都记成“没有测试”；
2. `tests/unit/filesystem/worktree-session.test.mjs` 里 FS-100、FS-105、FS-109 的 8 个 `test(名字, 函数名)` 被当成空的测试
   （spec-ids 只认写在调用里的函数体）；
3. 9 个真实层条目：`fs-real.mjs` 的场景在 `fs-real-perm.mjs` 等模块里，按“脚本名.json”归层时不算 `fs-real`。

### 测试的做法（规格没定、按推荐做的）

- **FS-59、FS-66 的“不进计时”**：§19.1 要这些套件设 Never，而 Never 下本来就不计时；那一步里临时设 10 分钟并让窗口失焦（焦点替身），
  看完改回 Never。FS-59 同一步里受保护路径的那张卡有 `mori.away_timer`（对照），被收窄拒绝的调用没有请求、计时与 `mori.away_decision`。
  登记在 defaults.md。
- **FS-57 进座位会话**：立项收到的投递先抄着你的原话，脚本按“第一处 `lim-create: `”读行，所以你的消息里这几个字写成 JSON 的
  `\u002d`（端点解析 `agent_message` 的参数时还原），立项只在那条消息里读到要调 MCP 的一行；另开一个会话发这条，免得与大消息的行混在一起。
- **FS-59 的 `task_handoff`**：有带编号的工具结果时 `done` 要证据，脚本的交接不带，所以那个 task 最后自己调 `task_handoff`（证据 `#1`，
  即 `board_read` 的结果；task 编号按 board.json 里已有的个数算）。
- **FS-60 晚连上的 MCP**：pi 只认那次请求里有的工具，所以对话第一次请求的回复晚 10 秒（`board_read`），工具注册之后的下一次请求才调用它；
  对话请求按全部 user 消息认（协作模式下请求最后另有程序给的 user 消息）。
- **FS-65、FS-68 的合成会话文件**：从这次套件里真实存下的关闭模式会话抄出第一条 user 消息之前的条目（`mori.pick`、模型、system 消息），
  system 消息只声明要的工具（工具对象取自同一次的协作模式会话），后面接一问一答；“没有 system 消息”的用 `mem-enhance-helpers` 的
  `seedSession`。FS-68 的 `defaultTools` 写在项目的 `.pi/settings.json`（defaults.md）。FS-65 的“不补工具”按会话文件里声明的工具在打开
  前后相同来看（打开会话可能写别的条目）。
- **FS-66 你的会话也在运行**：增强的材料另放一段今天的合成会话（你的会话还在第一轮）；增强的三个任务都有材料，都跑。
- **fs-app-worktree**（详见套件开头与 `fs-worktree-helpers.mjs`）：App 的 `HOME` 指向临时目录（defaults.md）；FS-100“重建后准备中失败”
  用合成端点的 `-404` 后缀模型（一次 404 后按 not_found 排除，会话照常建立）；FS-106“读不出改动”改坏 worktree 的 index，“删 worktree
  失败”让一个文件保持打开（`m3-helpers` 的 `holdFile`）；FS-102 的增强经进程桥 `enhance.set` / `enhance.run`，worktree 里的反馈是合成的
  文件；FS-105 的“仓库根不在了”是改名、“分支在别的 worktree 里检出”是测试自己 `git worktree add`、“子文件夹不在”是删掉 worktree 里的 `app/`。

### 屏 ｜ 行 ｜ 用例

`fs-app-team`、`fs-app-worktree` 覆盖的状态表行（用例写 `--only` 的步骤名与检查名的开头）。

| 屏 | 行 | 用例 |
| --- | --- | --- |
| fs-permissions.md 调用表 | 收窄越界、没人能批的会话 | fs-app-team `splitLimits`（“FS-57 the create, close and subscription sessions …”“FS-57 the dialog session in team mode …”）、`beforeApproval`（“FS-59 after "Allow for this session" …”）、`enhanceIdle`（“FS-66 nothing in the enhancement run asks …”） |
| fs-permissions.md 调用表 | 写受保护路径（Full access 也出卡） | `beforeApproval`（“FS-59 in Full access a write to a protected path inside write_paths …”） |
| fs-permissions.md 批准卡 | 工作路径里的调用 | `beforeApproval`（“FS-59 in Ask each time an edit inside write_paths …”） |
| fs-permissions.md 批准卡 | 可以按一个目录放行、选了按目录放行、选了按工具名放行、后台实例的卡 | `beforeApproval`（“FS-59 after "Allow for this session" on bash and allowing ../fs59-out by folder …”：两张后台卡的第二个按钮与之后的批准状态） |
| fs-permissions.md 工具卡 | 不出卡就拒绝 | `switching`（“FS-60 live, those three tool cards read "Denied · Team mode is on: …"”） |
| fs-permissions.md 工具卡 | 从会话记录载入的程序拒绝 | `reopen`（“FS-60 after a restart the RELAY_ONLY tool cards loaded from the session file …”） |
| team-blocked.md | 角色文件有错 | `roleTools`（“FS-61 a role file with "tools:" …”“FS-61 after deleting the tools line, Check again …”） |
| team-stream.md task 行 | `lock_wait` | `writeLock`（“FS-62 tasks without limits, with only commands: false …”“FS-62 a write: false task does not take the lock …”） |
| team-switch.md | 一直打开、关闭、已切换（运行中点开关） | `mergedMode`（“FS-57 the dialog is narrowed by the mode at the start of its run …”）、`switching` |
| v0 sessions.md | 新建或打开失败（横幅与会话行 Error） | `reopen`（“FS-68 a session whose declared tools are only read, board_read, …”） |
| fs-worktree.md 输入框下一行 | git 状态还没到 | fs-app-worktree `toggleShown`（“FS-98 the toggle shows only once the session’s first git status …”） |
| fs-worktree.md 输入框下一行 | 有提交的 git 仓库 | `toggleShown`（“FS-98 a repository with a commit shows the Worktree toggle …”“FS-98 turning the toggle on and off is recorded …”） |
| fs-worktree.md 输入框下一行 | 开关打开 | `toggleKinds`（“FS-98 a toggle turned on stays on after switching …”） |
| fs-worktree.md 输入框下一行 | 在 Mori worktree 里开的会话 | `nested`（“FS-98 Ctrl+N in a worktree session …”“FS-110 the new worktree sits next to …”） |
| fs-worktree.md 输入框下一行 | 是 git 仓库、还没有提交 | `toggleKinds`（“FS-98 a repository without commits …”） |
| fs-worktree.md 输入框下一行 | 不是 git 仓库 | `toggleKinds`（“FS-98 a folder that isn't a git repository …”） |
| fs-worktree.md 输入框下一行 | 读 git 状态出错 | `toggleKinds`（“FS-98 when repoInfo fails …”） |
| fs-worktree.md 输入框下一行 | 没装 git、git 太旧 | `noGit`（“FS-98 without git …”；git 太旧在 fs-replay 的 FS-13） |
| fs-worktree.md 输入框下一行 | 已经有消息、发送中，或会话有了自己的 worktree | `toggleBusy`（“FS-98 once the session has your message …”“FS-98 the toggle and Initialize git… never showed together …”）、`create`（“FS-98 a session that owns a worktree …”）、`noModel` |
| fs-worktree.md 输入框下一行 | 窄栏 | `toggleNarrow`（“FS-98 in a pane of 460 px or less …”） |
| fs-worktree.md 建 worktree | 建 worktree 中 | `create`（“FS-99 sending with the toggle on shows the stage line …”）、`busyCreate`（“FS-99 while the worktree is being created …”） |
| fs-worktree.md 建 worktree | 建好、消息已发出 | `create`（“FS-99 the result keeps the same session id …”“FS-99 the session file is in …”“FS-99 the message goes out …”“FS-99 Full access, the range …”）、`refChip`（“FS-99 with a file reference …”“FS-99 the mori.ref entry's path …”“FS-99 the full text sent …”） |
| fs-worktree.md 建 worktree | 建 worktree 失败 | `failure`（“FS-100 when a git step fails …”“FS-100 the failed attempt leaves …”“FS-100 after fixing the cause …”） |
| fs-worktree.md 建 worktree | 失败的原因 | `failure`（git 的原文）、`subfolder`（“FS-111 when <repo>\app only has untracked files …”） |
| fs-worktree.md 建 worktree | 建好了、消息没能发出 | `noModel`（“FS-100 when preparing fails after the rebuild …”） |
| fs-worktree.md 建 worktree | 建 worktree 中又发命令 | `busyCreate`（“FS-99 while the worktree is being created …”） |
| fs-worktree.md Initialize git 确认框 | 打开 | `initDialog`（“FS-109 the confirm dialog …”“FS-109 Initialize git… under "Not a git repository" …”） |
| fs-worktree.md Initialize git 确认框 | 成功 | `initSuccess`（“FS-109 after confirming …”）、`initFailures`（“FS-109 after removing the hook …”）、`initEmpty`（“FS-109 Initialize git in an empty folder …”） |
| fs-worktree.md Initialize git 确认框 | 失败、失败的原因 | `initRunning`（“FS-109 while the session is running …”）、`initSuccess`（“FS-109 Initialize git in a folder that is already a repository …”）、`initFailures`（“FS-109 without user.name …”“FS-109 when the first commit fails …”） |
| fs-worktree.md Initialize git 确认框 | 同一文件夹里别的开着的会话 | `initSuccess`（“FS-109 another open session in the same folder …”） |
| fs-worktree.md 侧栏与顶栏 | 项目分组 | `nested`（“FS-110 both worktree sessions are in the main folder's group …”）、`restart`（“FS-101 after a restart, before it is opened …”） |
| fs-worktree.md 侧栏与顶栏 | 分支标签 | `subfolder`（“FS-101 the worktree session of a subfolder session …”）、`restart`（“FS-101 after a restart …”） |
| fs-worktree.md 侧栏与顶栏 | 已归档的 worktree 会话 | `restart`（“FS-101 an archived worktree session's row hover …”） |
| fs-worktree.md 侧栏与顶栏 | 顶栏 | `create`（“FS-101 the top bar's project name …”） |
| fs-worktree.md 侧栏与顶栏 | 子文件夹里开的 worktree 会话 | `subfolder`（“FS-101 the worktree session of a subfolder session …”“FS-111 a session opened in <repo>\app …”） |
| fs-worktree.md 归档、恢复、删除 | 归档 worktree 会话 | `archiving`（“FS-104 archiving a clean …”“FS-104 a worktree with uncommitted files …”“FS-104 a worktree another open session uses …”“FS-104 archiving shows no confirm dialog …”） |
| fs-worktree.md 归档、恢复、删除 | 恢复、点已归档的 worktree 会话 | `reopen`（“FS-105 opening an archived session whose clean worktree was deleted …”） |
| fs-worktree.md 归档、恢复、删除 | 删除确认框，正在读 worktree | `deleting`（“FS-106 (clean) …”“FS-106 (changes) … first says "Checking its worktree…" with Delete disabled”） |
| fs-worktree.md 归档、恢复、删除 | 有拥有的 worktree，干净；有改动；已删除 | `deleting`（“FS-106 (clean) …”“FS-106 (changes) …”） |
| fs-worktree.md 归档、恢复、删除 | 读不出有没有改动 | `deleting`（“FS-106 (unknown) …”，`changes: null` 的一种；`worktrees.list` 失败的一种在单元层） |
| fs-worktree.md 归档、恢复、删除 | 别的开着的会话在用 | `deleting`（“FS-106 (in use) …”） |
| fs-worktree.md 归档、恢复、删除 | 没装 git | `noGit`（“FS-106 (no git) …”） |
| fs-worktree.md 归档、恢复、删除 | 没有拥有的 worktree，或它已经不在 | `deleting`（“FS-106 a session in a worktree it doesn't own …”） |
| fs-worktree.md 归档、恢复、删除 | 还没保存的 worktree 会话 | `deleting`（“FS-106 an unsaved worktree session …”） |
| fs-worktree.md 归档、恢复、删除 | 删 worktree 失败 | `deleting`（“FS-106 when deleting the worktree fails …”） |
| fs-worktree.md 打开 worktree 不在的会话 | 检出成功 | `reopen`（“FS-105 opening an archived session …”“FS-105 after deleting the worktree folder by hand …”“FS-105 a worktree with a directory junction …”） |
| fs-worktree.md 打开 worktree 不在的会话 | worktree 根还在、cwd 那个子文件夹不在 | `reopen`（“FS-105 when the worktree root is there but the session’s subfolder …”） |
| fs-worktree.md 打开 worktree 不在的会话 | 分支不在了 | `reopen`（“FS-105 when the branch is gone …”） |
| fs-worktree.md 打开 worktree 不在的会话 | 仓库根不在了 | `reopen`（“FS-105 when the repository root is gone …”） |
| fs-worktree.md 打开 worktree 不在的会话 | 没装 git | `noGit`（“FS-105 without git, opening a session whose worktree is gone …”） |
| fs-worktree.md 打开 worktree 不在的会话 | 分支正在别的 worktree 里检出 | `reopen`（“FS-105 when the branch is checked out in another worktree …”） |
| fs-worktree.md 打开 worktree 不在的会话 | 留下锁着的登记 | `reopen`（“FS-105 with a locked registration …”） |
| fs-worktree.md 打开 worktree 不在的会话 | 文件夹在、git 里没有它的登记 | `reopen`（“FS-105 a worktree folder that exists but isn't registered …”） |
| fs-worktree.md Storage → Worktrees | 分节 | `storageEmpty`（“FS-107 Settings has a Storage section …”） |
| fs-worktree.md Storage → Worktrees | 有留下的 worktree | `storage`（“FS-107 Storage lists exactly …”） |
| fs-worktree.md Storage → Worktrees | 没有 | `storageEmpty`（“FS-107 with no worktrees left …”） |
| fs-worktree.md Storage → Worktrees | 都在用 | `storage`（“FS-107 when every listed worktree is in use …”） |
| fs-worktree.md Storage → Worktrees | 没装 git | `noGit`（“FS-107 without git Storage says …”） |
| fs-worktree.md Storage → Worktrees | 确认、完成 | `storage`（“FS-107 the confirm dialog …”“FS-107 after confirming …”“FS-107 the activity log has "Clean up worktrees"”） |
| fs-worktree.md Storage → Worktrees | 后台 | `restart`（FS-112 的三条） |

fs-worktree.md 里没有用例的行（都不是这个包能补的）：

| 行 | 为什么没有 |
| --- | --- |
| Initialize git 确认框“进行中”、删除中、清理中、Storage“读取中”、打开时“检出中” | 不是验收条目，状态只停留一瞬，App 里断言不稳；它们的后一状态都有用例 |
| 在原文件夹也重建不起来；Storage“读取失败”；Storage 完成后逐项的 `Couldn’t delete <branch>` | App 层造不出（要后台进程的命令在特定一步失败）；`startInWorktree` 两次失败、`worktrees.list` 失败在单元层（FS-100、FS-106） |
| 检出超时 | 要等 120 秒；超时与清理在单元层（FS-97、FS-105 的 `timeoutMs`） |
| 没写盘就退出留下的 worktree；后台进程重新载入、界面重新加载两行 | 规格 §0 的已知限制与界面细节，不是 FS 验收条目 |
