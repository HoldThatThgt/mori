# 文件系统构建规格（续）：路径闸、命令分析、收窄、你不在与提问

状态：构建规格，按 [文件系统 Proposal](../proposals/file-system.md) 第一版（2026-10-26）写成，待评审。更新日期：2026-10-26。

本文是 [文件系统构建规格](file-system.md)（下称主文件）的一部分，因为每个文件不超过 2000 行而拆出：节号与主文件连续，这里是 §6–§10，其余各节在主文件。
术语与代码名见主文件 [§1](file-system.md)；命令、事件与会话条目汇总在 [§12](file-system.md)，模型看到的文字（身份段、工具说明、拒绝与提醒原文）在 [§14](file-system.md)，
临时默认值在 [§17](file-system.md)，要改的文件在 [§18](file-system.md)，验收条目 FS-n 在 [§19](file-system.md)。主文件的其他节第一次出现时链到主文件，之后只写“§n”。
本文的 pi 代码引用里，以 `dist/` 开头的（`dist/core/…:行号`、`dist/utils/…:行号`）相对 `app/node_modules/@earendil-works/pi-coding-agent/`；
只写文件名的 `bash.js:…`、`powershell.js:…`、`edit.js:…` 在它的 `dist/core/tools/` 下，`agent-session.js:…`、`sdk.js:…`、`session-manager.js:…` 在 `dist/core/` 下；
`agent-loop.js:…` 在 `app/node_modules/@earendil-works/pi-agent-core/dist/` 下。

## 6. 路径闸

路径闸实现 proposal §3“路径闸”、§4“受保护路径”“权限模式”、§5.1、§6 的权限按钮与批准卡、§9 第 1–3 条、§12 第 3、7 条和 §13 第 1、2、20 条。
它不是新扩展：现有的批准扩展 `mori-approval`（`app/src/kernel/approval.ts`）的 `tool_call` 处理器从“按工具名查表”（`app/src/kernel/approval.ts:97-101` 的 `gateFor`）
改成本节的判断顺序；挂起的请求、停止、实例的卡交给 Team、共用的 `ApprovalPolicy` 都沿用（`app/src/kernel/approval.ts:68-121`、`:124-304`）。
新的纯函数放在 `kernel/pathGate.ts`：路径解析、受保护名单、调用分类。命令的写入目标由 `kernel/commandScan.ts` 分析（§7），本节只用它的结果。

pi 自己不判断路径：它的 `docs/security.md` 写明 pi 以启动它的账户的权限读、改、执行文件，不在每次工具调用前问，也没有内置沙箱
（`app/node_modules/@earendil-works/pi-coding-agent/docs/security.md:3`、`:99`）。
路径闸也不是沙箱（proposal §5.1“这不是沙箱”、§9 第 3 条）：脚本和程序自己打开的文件、MCP 工具写的文件，Mori 看不到。

### 6.1 判断顺序

每个工具调用在 `mori-approval` 的 `tool_call` 处理器里按下表从上往下判断，第一条有结果的就是结论（§8、§9 引用这里）。
处理器之前还有 `mori-team`、`mori-memory` 的 `tool_call`（扩展顺序 mori-models、mori-team、mori-memory、mori-approval、mcp，`app/src/kernel/sessions.ts:293-308`），
它们先拒绝的调用不到这里（pi 按顺序调处理器、第一个 block 生效，`app/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:957-972`）；这两处的拒绝照旧（mori-team 的交接后拒绝、强制填写；mori-memory 的记忆目录写保护与增强会话的 write、edit，记忆规格 §7.7、§9.6）；mori-team 现在按工具开关的“对话只转达”拒绝由 §8 换成收窄。

| 步 | 条件 | 结论 | `mori.tool_gate` |
| --- | --- | --- | --- |
| 1 | 按职责给的工具（§6.2 的 `duty`）：TaskBoard 的 11 个工具、`memory`、`ask_user_question`（2026-10-27 注：收尾检查落地后另有 `finish`，见 [finish-check.md](finish-check.md) §11） | 放行 | `free` |
| — | 其余调用先分类（§6.2–§6.5；命令先经 §7 的 `scanCommand`），第 2–4 步共用这个结果 | — | — |
| 2 | 收窄：`limits.ts` 对这个调用给出拒绝原文（§8） | 拒绝，原文回给模型，不出卡 | `deny` |
| 3 | 分类得到的 scope 为 `outside` 或 `protected` | 全部目标被按目录放行覆盖（§6.9）→ 放行，但 Ask each time 下调用在工作路径里（含 `.work`）还有写入目标时，按 scope `inside` 的调用到第 4 步（卡上没有原因行与按目录放行，可按工具名放行）（2026-10-27 注：负责人定）；否则会话没人能批（§6.11）→ 拒绝（§6.15 的原文）；否则出卡 | `dir` / `deny` / `ask` |
| 4 | scope 为 `inside`，权限模式（§6.7） | 读取 → 放行；`write`、`edit` 写 `.work` → 放行；Full access → 放行；Ask each time：工具名在“Allowed for this session”里 → 放行，否则没人能批 → 拒绝，否则出卡 | `free` / `free` / `full` / `session` / `deny` / `ask` |
| 5 | 第 3、4 步出卡 | 挂起请求（§6.13 的载荷），交给无人应答模块计时（§9） | `ask` |

- **停止中**（`rejectForStop` 到 `endStop`，`app/src/kernel/approval.ts:263-280`）：除 `duty` 与 `read` 两种外，调用一律按 `Rejected: the user stopped the run.` 拒绝，不出卡
  （同现在 `app/src/kernel/approval.ts:180`：现在只放过 `FREE_TOOLS`，即这两种）。写 `.work` 的 `edit`、`write` 的 `gate` 虽是 `free`，停止中也拒绝：停止之后不再执行任何写入。
- 一次判断只算一次分类，在第 2 步之前算（第 1 步的调用不分类）；第 2、3、4 步共用它：收窄要用分类与写入目标判断 `write_paths` 和 `.work`（§8 的 `checkLimits`）。
- 分类不抛错：`realTarget` 自己接住文件系统的错误（§6.3）。万一分类或 `commandScan` 抛错，处理器记日志 `[kernel] path gate: <原文>`，
  这个调用按 scope `outside`、一个理由 `unresolved`（`text` 为工具名）处理，不交给 pi（pi 会把处理器的异常变成 `Extension failed, blocking execution: …`，
  `app/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:341-346`）。
- 读取类工具在第 2 步也不会被收窄（§8 的 `limits` 只管写、命令、MCP），所以第 4 步对读取总是放行：读取在任何模式、任何路径都不问（proposal §5.1、§9 第 2 条）。
- 路径闸放行 `bash`、`powershell` 的调用，或放行写进 `.work` 的 `edit`、`write`（不论在哪一步放行，含等卡后你允许），交还 pi 之前先 `await ensureWork(ctx.cwd)`（§7.10）；
  `.work` 建不起来时拒绝这次调用，原因见 §7.10。

### 6.2 调用分类

`pathGate.ts` 的 `callKind(toolName, input)` 只看工具名和已经 pi 校验过的参数（`tool_call` 处理器拿到的是准备参数并校验之后的 `event.input`，`app/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:491-499`）：

| 种类 | 工具 | 写入目标 |
| --- | --- | --- |
| `duty` | `TEAM_TOOLS`（`app/src/shared/team.ts:245-248`）、`memory`（`MEMORY_TOOL`，`app/src/kernel/teamHost.ts:19`）、`ask_user_question`（§10）；（2026-10-27 注：收尾检查落地后另有 `finish`，`FINISH_TOOL`，见 [finish-check.md](finish-check.md) §11） | 不看 |
| `read` | `read`、`grep`、`find`、`ls`（`READ_ONLY_TOOLS`，`app/src/shared/protocol.ts:61`） | 没有 |
| `file` | `edit`、`write`，且 `input.path` 是字符串 | `path` 按 §6.3 解析出的一个目标（写进，不是删除） |
| `command` | `bash`、`powershell`，且 `input.command` 是字符串 | `commandScan.ts` 的 `ScanResult`（§7.2）：写入目标（解析出的路径或看不出；是不是删除或移走；是不是落进目录）、换过目录之后执行的非只读部分；或者分析不了（`ok: false`） |
| `other` | 其余全部：`mcp__<服务>__<工具>`、扩展和包注册的工具 | 不分析（proposal §5.1 最后一条、§13 第 2 条） |

- 只按名字认：扩展用同名工具替换内置的 `edit`、`write`、`bash`（扩展与 SDK 的工具后放进表里，同名的盖过内置的，`app/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2855-2869`）仍按这一行判断；`edit`、`write` 的参数里没有字符串 `path`、`bash`、`powershell` 的参数里没有字符串 `command` 时按 `other`。
- 经 `ctx.executeTool` 的嵌套调用同样经过 `tool_call`（`app/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:387-411`），按同样的规则判断。
- 现在的 `FREE_TOOLS`（`app/src/kernel/approval.ts:27`）拆成两组：`DUTY_TOOLS`（TaskBoard 工具、`memory`、`ask_user_question`）和 `READ_ONLY_TOOLS`。
  （2026-10-27 注：收尾检查落地后 `FREE_TOOLS` 里已有 `finish`，拆分时它去 `DUTY_TOOLS`，不落进 `other`：Ask each time 下会出卡，协作模式下对话的 `mcp: false` 会拒绝它；见 [finish-check.md](finish-check.md) §11）

本节用到的 `ScanResult` 字段（类型定义见 §7.2）：

| 字段 | 本节怎样用 |
| --- | --- |
| `ok: false`、`reason` | 分析不了（§7.8）：整个调用记一个理由为 `unanalyzed` 的目标（`path` 为 `null`，`text` 为 `reason`），scope `outside`，没有按目录放行（§6.4、§6.9） |
| `writes: ScanWrite[]`，每项 `{ form, text, path \| null, unknown, remove, into }` | 每个认出的写入目标：`path` 是按命令里的当前目录解析出的绝对路径（§7.6 的规则，字面，不跟链接），看不出时为 `null`（变量、`~`、通配符等，`unknown` 写原因，proposal §5.1）；`text` 是命令里的原文。`remove` 为真表示删除或移走这个路径（`rm`、`rmdir`、`Remove-Item`，`mv` / `Move-Item` 的源，`Rename-Item` 的原名），为假表示写进它（重定向、`tee`、`cp` / `mv` / `Copy-Item` 的目标、`mkdir`、`Set-Content` 之类）。只有 `remove` 为真的目标落在工作路径本身或它的上级时才算删掉工作路径（§6.4）；`cp a.txt .` 的目标 `.` 是写进工作路径。`into` 为真表示从命令文字就看得出东西落在 `path` 这个目录里面（`cp x ../bk/`、`cp -t ../d a`，§7.5“落进目录”），按目录放行时放行 `path` 本身而不是它的上级（§6.9） |
| `leaves: ScanLeave[]`，每项 `{ form, text, dir \| null, command }` | 命令换过目录（`cd`、`Set-Location`、`pushd`、`git -C`、`--git-dir` / `--work-tree`、`GIT_DIR` / `GIT_WORK_TREE`）之后还执行了非只读的部分（proposal §5.1）：`dir` 是换到的目录（字面），看不出时为 `null`。§7 对每一次换目录都报告，不判断在不在工作路径里（§7.7）；本节按真实路径判断，仍在工作路径里的丢掉（§6.4） |

`git` 在自己仓库里的提交、检出、合并不产生 `.git` 下的写入目标（proposal §4“受保护路径”），由 §7 保证；本节不另做例外。

### 6.3 路径解析

**词法解析**（`pathGate.ts` 的 `resolveToCwd(filePath, cwd)`）：照抄 pi 1.3.0 的 `resolveToCwd`
（`app/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js:42-44`，规则在 `dist/utils/paths.js:50-87`），pi 的 `edit`、`write` 就按它定位文件
（`dist/core/tools/write.js:31`、`edit.js:94`，都是 `resolveToCwd(path, ctx?.cwd || cwd)`）。pi 的包只导出 `.` 和 `./rpc-entry`，不能 import（`app/node_modules/@earendil-works/pi-coding-agent/package.json:13-21`）。

1. 特殊空格（U+00A0、U+2000–U+200A、U+202F、U+205F、U+3000）换成普通空格；
2. 去掉开头的一个 `@`；
3. win32 上 `/c/…`、`/mnt/c/…`、`/cygdrive/c/…` 换成 `C:\…`（以 `//` 开头或含 `\` 的不换）；
4. `~`、`~/…`、`~\…`（后者只在 win32）展开到 `os.homedir()`；
5. `file://` 网址换成路径；
6. 绝对路径直接 `path.resolve`，否则 `path.resolve(cwd, p)`；`cwd` 本身只做第 3–5 步（pi 对 baseDir 调 `normalizePath` 不带选项）。

这份照抄现在在 `app/src/kernel/memoryExtension.ts:129-173`（`isUnicodeSpace`、`windowsShellPath`、`normalizePath`、`resolveToCwd`）和 `:175-182`（`insideDir`），
整段移到 `pathGate.ts`，`memoryExtension.ts` 的 `guardWrite` 改为 import（记忆规格 §7.7 的行为除下面 `..` 开头的名字外不变）。主进程的 `app/src/main/files.ts:21-32` `resolveToolPath`
给文件阅读器用，属于主进程，不改。`cwd` 一律用 `ctx.cwd`（pi 的工具也按它解析，`app/src/kernel/sessions.ts:426` 把 `args.cwd` 传给 `createAgentSession`）；worktree 会话的 `ctx.cwd` 就是 worktree（[§11](file-system.md)）。

**在不在里面**（`insideDir(dir, target)`）：照 pi 的 `getCwdRelativePath`（`dist/utils/paths.js:88-95`）：`path.relative(dir, target)` 为空，或既不等于 `..`、
也不以 `..` 加分隔符开头，且不是绝对路径。win32 的 `relative` 不分大小写、统一 `/` 与 `\`，前缀相同的兄弟目录（`D:\proj-x` 对 `D:\proj`）不算在里面。
现有写法（`app/src/kernel/memoryExtension.ts:179-182`）只看“以 `..` 开头”，把 `..notes` 这种名字的文件算在外面；移过来时改成 pi 的写法（MEM-13 现有的断言不受影响）。

**链接**（临时默认值）：按“最近一个存在的上级的真实路径”判断，照 Claude（写入经过链接时，按它最终落到的位置判断，Claude Code 文档 permissions“Writes through a symlink”）：

1. 词法解析的结果不在工作路径里：直接算工作路径外，**不碰文件系统**，它的真实路径就取词法路径。这样 `\\主机\共享\…` 这类网络路径不会让 Windows 去连那台主机、送出凭据
   （同 `app/src/main/files.ts:56-61` 不打开网络路径的理由），工作路径外的链接指回里面的情况按外面问，只会多问，不会少问。
2. 在工作路径里：从目标往上找第一个 `lstat` 能看到的路径（含悬空的链接本身），对它取 `fs.realpathSync.native`（Windows 上解析符号链接、目录联接、8.3 短名），
   再接上还不存在的那几段；工作路径本身同样取真实路径（每次判断取一次，几个目标共用）。两者再用 `insideDir` 比。
3. `realpath` 失败（悬空的链接、链接成环、没有权限），或 `lstat` 报 `ENOENT`、`ENOTDIR` 以外的错：这个目标按工作路径外，记一条日志
   `[kernel] path gate: cannot resolve <路径>: <原文>`。

每次判断时现算，不缓存（不监视文件）。上限：一个目标最多“段数”次 `lstat` 和一次 `realpath`，都是本机路径（只有工作路径本身在网络上时才会碰网络，那是你打开的文件夹）；
一个调用最多解析 100 个写入目标，第 101 个起不再解析，记作看不出（理由 `unresolved`，按写到外面问；临时默认值），所以一次判断的同步文件系统调用有上限。
`realTarget` 的 `lstat`、`realpath` 从参数传入（默认是 `node:fs` 的同步版），单元测试据此计数（FS-29）。

**名字的比较**（受保护名单、`.work`）：按段比，段先去掉 NTFS 流名（第一个 `:` 及之后，绝对路径的盘符除外），再去掉末尾的 `.` 和空格（Windows 打开文件时也这样去掉），
不分大小写。所以 `.GIT\config`、`.git.\config`、`.git::$INDEX_ALLOCATION\config` 都算 `.git`。

### 6.4 四种归类

每个写入目标（`file` 的那一个，`command` 的每个 `writes`）归进一类：

| 类 | 条件（按顺序，先满足的为准） |
| --- | --- |
| `protected` | `remove` 为真（§6.2，只有命令有），且目标就是工作路径本身或它的上级（真实路径或词法路径；`rm -rf .`、`Remove-Item -Recurse ..`、`mv ../proj ../old` 之类：删掉或移走它们就删掉了工作路径，proposal §4） |
| `inside` | `remove` 为假，且目标就是工作路径本身（`cp a.txt .`、`mkdir -p .`：写进工作路径，不是删掉它） |
| `outside` | 词法路径不在工作路径里，或真实路径不在工作路径里，或真实路径取不到（§6.3）；其中路径命中受保护名单的改为 `protected`（见下） |
| `work` | 真实路径相对工作路径的第一段是 `.work`（`.work` 目录和它下面的一切，§7） |
| `protected` | 真实路径或词法路径相对工作路径的任一段命中 §6.5 的名单 |
| `inside` | 其余 |

- `.work` 先于名单：`.work` 里任何东西都不问（proposal §4“在任何模式下写它都不问”）。`.work` 本身是链接、指到别处时，按真实路径归 `outside`。
- 工作路径外的目标：完整的绝对路径（词法路径；词法在里面、真实在外面的再加上真实路径）任一段命中名单时归 `protected`（临时默认值：例如 `C:\Users\<你>\.gitconfig`、别的仓库的 `.git\hooks`；
  这样它们不能被按目录放行，每次都问，§6.9）。工作路径里的目标只比相对工作路径的那几段，所以打开的文件夹本身在 `.cargo` 之类目录下时，里面的写入不因此受保护。
- `command` 的 `writes.path` 为 `null` 的目标不归类，记作看不出（理由 `unresolved`）；`ok: false` 的命令记一个理由 `unanalyzed` 的目标（§6.2）。
- 每个 `leaves` 的 `dir` 由这里按上表的路径规则（`remove` 为假，词法路径与真实路径都看）判断在不在工作路径里（§7 对每一次换目录都给 leave，不判断，§7.7）：
  在里面的（不论 `inside`、`work` 还是名单里的目录）丢掉，因为换到的目录其实没离开工作路径，之后的写入由 §7 按新的当前目录解析成 `writes`；`dir` 为 `null` 或在外面的
  （含字面在里面、经过目录联接落到外面的）记作理由 `leaves`。
- 理由为 `outside` 的目标在批准请求里带真实路径（§6.3：词法上在外面的就是词法路径）；`protected` 的带真实路径，真实路径不在名单上、词法路径在名单上时带词法路径（显示命中名单的那个）。

一个调用的 **scope**（批准卡和判断用）：有 `protected` 目标 → `protected`；否则有 `outside`、`unresolved`、`leaves`、`unanalyzed` → `outside`；否则 → `inside`。
`read`、`other`、没有认出写入的命令都是 `inside`：意思是“Mori 没看出它写到工作路径外或受保护路径”，不是“它只写里面”。

### 6.5 受保护路径名单

`pathGate.ts` 的常量，照 Claude Code 文档 permission-modes 的“Protected paths”（2026-10-26 核对）加上 Mori 和 pi 的两个目录：

| 种类 | 名单 | 怎样算命中 |
| --- | --- | --- |
| 目录 | `.git`、`.vscode`、`.idea`、`.husky`、`.cargo`、`.devcontainer`、`.yarn`、`.mvn`、`.claude`、`.mori`、`.pi` | 任一段等于它 |
| 两段的目录 | `.config/git` | 连续两段依次等于 `.config`、`git` |
| 文件 | `.gitconfig`、`.gitmodules`；`.bashrc`、`.bash_profile`、`.bash_login`、`.bash_aliases`、`.bash_logout`、`.zshrc`、`.zprofile`、`.zshenv`、`.zlogin`、`.zlogout`、`.profile`、`.envrc`；`.npmrc`、`.yarnrc`、`.yarnrc.yml`、`.pnp.cjs`、`.pnp.loader.mjs`、`.pnpmfile.cjs`、`bunfig.toml`、`.bunfig.toml`；`.bazelrc`、`.bazelversion`、`.bazeliskrc`；`.pre-commit-config.yaml`、`lefthook.yml`、`lefthook.yaml`、`.lefthook.yml`、`.lefthook.yaml`；`gradle-wrapper.properties`、`maven-wrapper.properties`；`.devcontainer.json`；`.ripgreprc`、`pyrightconfig.json`；`.mcp.json`、`.claude.json` | 最后一段等于它 |
| 工作路径本身 | 工作路径与它的每个上级 | 命令删除或移走它们（`remove` 为真，§6.4 第一行）；写进工作路径（`cp a.txt .`）不算 |

- Claude 的 `.claude` 例外（它自己的 worktree、计划、记忆文件）、`--plugin-dir`、`dev-mods/` 和“设置文件是链接时指向的文件”都是 Claude 自己的东西，Mori 不照搬；`.claude` 整个受保护。
- `.mori` 整个受保护：`.mori/agents`、`.mori/models.json` 是 Mori 读的配置，`.mori/worktrees/<名字>` 是别的会话的工作路径（§11）。worktree 会话里比的是相对它自己工作路径的段，
  主文件夹的 `.mori` 对它是工作路径外（proposal §5.4：写主文件夹等于写到外面）。
- `.pi` 是 pi 的项目设置（`<cwd>/.pi/settings.json`，`app/node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js:123-124`）。

### 6.6 不算 Agent 写入的

路径闸只看工具调用。pi 和 Mori 自己写的文件不经过 `tool_call`，不判断、不出卡（proposal §9 第 2 条最后一句）：会话文件、pi 截断输出写进 `os.tmpdir()` 的文件
（`dist/utils/output-files.js:15-29`）、pi 下载到 `<agentDir>/bin` 的 rg / fd、快照与内部仓库（[§4](file-system.md)）、Mori 建 `.work` 和它的 `.gitignore`（§7）、Mori 的设置与记忆文件。
`memory` 工具写 `<userData>/memory` 是按职责给的工具（第 1 步放行）。

### 6.7 两种权限模式

`ApprovalMode` 从 `'ask' | 'all'`（`app/src/shared/protocol.ts:47`）改为 `'ask' | 'full'`，`'all'` 去掉（proposal §12 第 3 条）。界面名 Ask each time / Full access。
仍是一个用户会话一份（`ApprovalPolicy`，对话会话和它的全部实例共用，平行 Agent 规格 §11.1），只在后台进程内存里；新建、重新打开的会话都从 `ask` 开始，不按文件夹记住（proposal §12 第 3 条）。

| 调用 | Ask each time | Full access |
| --- | --- | --- |
| 读取（任何路径） | 放行 | 放行 |
| `edit`、`write` 写 `inside` | 问（可按工具名 Allow for this session） | 放行 |
| `edit`、`write` 写 `work` | 放行 | 放行 |
| 命令，scope `inside`（目标都在 `inside` / `work`，或没认出写入） | 问（可按工具名） | 放行 |
| MCP 与扩展工具 | 问（可按工具名） | 放行 |
| 任何目标 `outside` / `unresolved` / `leaves` / `unanalyzed` | 问（只有 `outside` 可按目录放行，§6.9） | 问（同左） |
| 任何写入目标 `protected` | 每次都问 | 每次都问 |

- Ask each time 下命令总是问，哪怕目标只在 `.work`：命令能做的不只是认出的那几个写入（proposal §4“权限模式”只说写 `.work` 不问，指 `edit`、`write`）。
- **切到 Full access**：界面先确认（§6.13 下面的确认框，原文照 proposal §6）。后台进程 `setMode('full')` 之后，这个用户会话里**所有 Agent** 挂起的请求中 scope 为 `inside` 的按允许结束
  （`by: 'full'`，工具卡标 Full access）；scope 为 `outside`、`protected` 的继续挂着，因为 Full access 下它们也要问。之后新建的实例同样从 Full access 开始。
- **切回 Ask each time**：不确认；挂着的请求都不变（它们在两种模式下都要问），“Allowed for this session”的工具名和目录都保留。
- 增强会话一开始就是 Full access，并且没人能批（§6.11、§8）；`app/src/kernel/sessions.ts:482-486` 的 `userApproval` 从 `setMode('all')` 改为 `new ApprovalPolicy({ mode: 'full', canAsk: false })`。

### 6.8 Allow for this session（按工具名）

沿用现在的集合（`ApprovalPolicy.allowed`，`app/src/kernel/approval.ts:72`），只是范围收窄（proposal §9 第 2 条、§10“方案第 5.7 节”）：

- 只在 Ask each time、只对 scope `inside` 的调用生效（第 4 步）。写到外面、受保护路径的调用不论工具名在不在集合里都走第 3 步。
- 在 scope 为 `inside` 的卡上选它：放行这一次（`by: 'user'`），记下工具名，这个用户会话里所有 Agent 挂起的、同名且 scope 为 `inside` 的请求一并放行（`by: 'session'`，同 `app/src/kernel/approval.ts:111-114`）。
- 对 scope 为 `outside`、`protected` 的请求答 `allowSession`：命令失败，原文 `Allow for this session doesn’t apply to writes outside the working directory or to protected paths.`；卡不变。
- Forget：`approval.forget { toolName }` 删掉这个名字（同现在）。

### 6.9 Allow writes to <目录> for this session（按目录放行）

proposal §13 第 1 条：写到外面的卡上可以放行目标文件所在的目录。

- **什么时候给这个选项**：scope 为 `outside`，并且每个目标的理由都是 `outside`、都有解析出的路径，而且要放行的目录（下一条）没有一个是盘符根或共享根（`D:\`、`\\主机\共享\`：写 `D:\x.log` 时不给）。
  有 `protected`、`unresolved`、`leaves`、`unanalyzed` 的调用没有这个选项（只有 Allow once 和 Deny）：看不出目标就不知道放行哪个目录，换了目录的命令后面写哪里也看不出来，分析不了的命令同样（临时默认值）。
- **放行哪些目录**：每个目标的**落点目录**：`into` 为真（§6.2，只有命令有）时是目标本身，否则是它的上一级目录（`path.dirname`）；都取真实路径，去掉重复（不分大小写），按目标出现的顺序。
  写 `D:\out\a\b.log` 时放行 `D:\out\a`；`cp x ../bk/` 放行 `../bk` 解析出的目录本身（proposal §13 第 1 条）；`cp a ../b` 看不出 `../b` 是不是目录，`into` 为假，放行它的上一级（宽一级，§7.5）。
  命令有几个目标就可能有几个目录，选它就一起放行。
- **覆盖到哪里**（临时默认值）：只覆盖直接放在这个目录里的目标，**不含子目录**（proposal §9 第 2 条“只放行那一个目录”）：放行 `D:\out\a` 后写 `D:\out\a\c.log` 不问，写 `D:\out\a\sub\c.log` 还问。
  比较时用 `relative(目录, 目标的落点目录) === ''`（win32 不分大小写）。
- **什么时候生效**：两种模式都生效（第 3 步）。一个调用只有在 scope 为 `outside`、每个要问的目标都是理由 `outside` 且都被覆盖时才按目录放行（`by: 'dir'`，工具卡标 Allowed for this session）；
  Ask each time 下，这样的调用在工作路径里（含 `.work`）还有写入目标时（例如 `cp a.txt ../out/ && rm -rf src`）不按目录放行，按 scope `inside` 的调用到第 4 步按模式判断：出卡（卡上没有原因行与按目录放行，第二个按钮是按工具名的 Allow for this session），或已按工具名放行；只写外面的调用照常按目录放行；Full access 下不变（2026-10-27 注：负责人定）。切到 Full access 时，这样挂着的请求按目录放行结束（`by: 'dir'`）；
  只要有一个目标没被覆盖，或有 `unresolved`、`leaves`、`unanalyzed`、`protected`，就出卡。受保护路径永远不被覆盖（它们归 `protected`，§6.4）。
- **选了之后**：放行这一次（`by: 'user'`），把这些目录记进 `ApprovalPolicy.allowedDirs`，这个用户会话里所有 Agent 挂起的请求中现在全部被覆盖的一并放行（`by: 'dir'`）。
  请求不满足“什么时候给这个选项”时答 `allowDir`：命令失败，原文 `This request can’t be allowed by folder.`，卡不变。
- **共用与保存**：与工具名一样，一个用户会话一份，对话和全部实例共用，只在内存里；重新载入后台进程后丢掉（重启提示 “Restarted · Queued messages, pending approvals, and “Allow for this session” choices weren’t restored” 已经涵盖）。
- **Forget**：权限菜单的“Allowed for this session:”列表里每个目录一项 `Writes to <目录>`，带 Forget；`approval.forget { dir }` 删掉它（按 `relative` 为空比，不分大小写；
  列表里没有这个目录时什么都不做，同现在忘掉不在集合里的工具名）。忘掉之后挂起的请求不变，之后的写入又问。
- **上限**：`allowedDirs` 只随你的选择增长，不设上限（同工具名的集合）；判断时按目标逐个比，一个调用最多 100 个目标（§6.3）。

### 6.10 MCP 与扩展工具

`other` 种类：Ask each time 下照旧问，可按工具名 Allow for this session；Full access 下不问，也不分析参数（proposal §5.1、§13 第 2 条）。批准卡的 scope 是 `inside`，没有目标行。

### 6.11 没人能批的会话

`ApprovalPolicy` 加构造选项 `canAsk`（默认真）。为假时，第 3、4 步该出卡的调用直接拒绝，原文见 §6.15，不发 `mori.approval_request`、不交给 Team、不计时。
现在只有增强会话和它的实例为假（`app/src/kernel/sessions.ts:387-389` 的 `isHeadless`；proposal §13 第 20 条，§8 写增强会话的其余部分）。它们在 Full access 下，所以实际被拒绝的只有写到工作路径外、受保护路径的
`edit`、`write`（这两个在增强会话里先被 `mori-memory` 一律拒绝，记忆规格 §9.6）和命令；工作路径里的命令和 MCP 照旧自动执行（proposal §10“记忆规格”）。

### 6.12 后台实例的卡

同现在（平行 Agent 规格 §11.3，`docs/v1/screens/team-approvals.md`）：实例的 `ApprovalGate` 把请求交给 Team（`GateOutput.onRequest`），Team 补上角色与 task，在用户会话的信封上发
`mori.team_approval_request`（`app/src/kernel/team.ts:1338-1345`，载荷是 `{ ...request, role, task, taskTitle }`，所以 §6.13 新加的字段原样带过去，只改 `app/src/shared/team.ts:290-308` 的类型）。
答复仍经 `approval.answer` 按 `requestId` 交给那个实例（`app/src/kernel/sessions.ts:1179-1184`、`:1408-1413`）。实例的 `cwd` 与用户会话相同（`app/src/kernel/team.ts:1062`），按目录放行和按工具名放行都是这个用户会话共用的。
计时与到时拒绝见 §9。

### 6.13 批准请求的载荷与卡片

`ApprovalRequestInfo`（`app/src/shared/protocol.ts:538-547`）、`mori.approval_request`（`:687-697`）、`TeamApprovalRequest` 加三个字段，由后台进程判定，界面不再自己猜（proposal §7）：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `scope` | `'inside' \| 'outside' \| 'protected'` | §6.4 的 scope |
| `targets` | `ApprovalTarget[]` | 要问的原因，按命令里出现的顺序；scope 为 `inside` 时为空 |
| `allowDirs` | `string[]` | 选 Allow writes to … for this session 会放行的目录（§6.9）；没有这个选项时为空 |

`ApprovalTarget = { reason: 'outside' | 'protected' | 'unresolved' | 'leaves' | 'unanalyzed'; path: string | null; text: string }`：`path` 按 §6.4 最后一条（词法上在外面的是词法路径，
经过链接的是真实路径；`unresolved`、`unanalyzed` 和看不出目录的 `leaves` 为 `null`），`text` 是参数里的原文（`edit`、`write` 的 `path`，命令里的那一段；`unanalyzed` 为 §7.8 的原因）。

后台进程这边：`Pending`（`app/src/kernel/approval.ts:30-41`）记下这三项，`requests()`（`:289-292`，`LiveSnapshot.approvals`）原样带上，界面重新载入后接上时照旧显示。
界面这边：`PendingApproval`（`app/src/renderer/src/state/model.ts:60-69`）加这三项；`app/src/renderer/src/state/transcript.ts:256-257` 的 `applyApproval` 现在只取 `requestId`、`toolCallId`、`toolName`、`args` 四项，
改为连同这三项一起记下（后台卡的 `applyTeamApproval`，`app/src/renderer/src/state/teamEvents.ts:117-125`，已经整条记下）。

卡片（`app/src/renderer/src/components/ApprovalCard.tsx`）：

- 去掉界面自己的判断：`outsideFolder`（`app/src/renderer/src/components/ApprovalCard.tsx:66-75`）和 `CardView.outside`、警示行 `This file is outside the working directory`（`:119-121`）删掉。
  它按 `..` 和绝对路径猜，与 pi 的解析不一致（不去 `@`、不认 `/c/…`）。参数里的完整路径一行（`Path`）照旧显示原文。
- 警示区按 `targets` 每个一行（`path` 为 `null` 时显示 `text`），最多 5 行，多的写 `and {n} more`（临时默认值）：

| `reason` | 一行的文字 |
| --- | --- |
| `outside` | `Writes outside the working directory: <path>` |
| `protected` | `Protected path: <path>`（工作路径本身也这样写） |
| `unresolved` | `Writes to a path Mori can’t resolve: <text>` |
| `leaves` | `Runs outside the working directory: <path 或 text>` |
| `unanalyzed` | `Couldn’t analyze this command: <text>`（`<text>` 是 §7.8 的原因） |

  不可见控制字符的警示行不变；警示区里的路径同样经过 `markHidden`。
- 第二个选项（Alt+2）按请求定：

| 请求 | 按钮 | 下方小字 |
| --- | --- | --- |
| scope `inside`，命令 | `Allow “Run commands” for this session` | `You won’t be asked again for commands in this session, unless Mori can’t analyze a command or detects that it writes outside the working directory or to a protected path, or changes to a folder outside it.`（列出放行之后仍出卡的全部情况：§7.8 分析不了，§6.4 的 `outside`、`protected`、`unresolved`、`leaves`；§17） |
| scope `inside`，`edit` / `write` | `Allow “Edit files” for this session` / `Allow “Write files” for this session` | `You won’t be asked again for “Edit files” in this session, except outside the working directory or in protected paths.`（Write files 同理） |
| scope `inside`，其他工具 | `Allow “<服务> · <工具>” for this session` / 原名（同现在 `app/src/renderer/src/components/approvalLabel.ts:10-16`） | `You won’t be asked again for “<label>” in this session.`（同现在） |
| `allowDirs` 有一个 | `Allow writes to <目录> for this session` | `You won’t be asked again in this session for writes directly in this folder (not its subfolders).` |
| `allowDirs` 有几个 | `Allow writes to these folders for this session` | `You won’t be asked again in this session for writes directly in: <目录>, <目录>.` |
| 其余（`protected`；有 `unresolved`、`leaves`、`unanalyzed`；要放行的目录是盘符根或共享根） | 没有第二个按钮，Alt+2 不起作用 | 没有 |

  Alt+2 由 App 的全局按键经 `answerFrontApproval(tabKey, 'allowSession')` 转来（`app/src/renderer/src/App.tsx:102`）；卡片按上表把它换成 `allowSession` 或 `allowDir`，没有第二个按钮时返回假（不吞这个按键）。
- 后台实例的卡同样显示这些行，归属行不变。
- 切到 Full access 的确认框（`app/src/renderer/src/components/PermissionMenu.tsx:113`）：标题 `Switch to “Full access”?`，正文 `Edits, writes, and commands inside the working directory will run without asking. Mori still asks before writes it can detect outside it or to protected files. This isn’t a sandbox: scripts and MCP tools can still write anywhere.`（proposal §6），
  按钮 `Full access` 与 `Cancel`，焦点在 `Cancel`，警示色。屏幕状态表见 `docs/v1/screens/fs-permissions.md`。

### 6.14 mori.tool_gate 与工具卡

- `ToolGate`（`app/src/shared/protocol.ts:652`）改为 `'ask' | 'session' | 'dir' | 'full' | 'free' | 'deny'`：`session` 按工具名放行，`dir` 按目录放行，`full` Full access 放行，`free` 读取、按职责给的工具、写 `.work`，
  `deny` 不出卡就拒绝（第 2 步，或没人能批）。
- `ApprovalEndBy`（`app/src/shared/protocol.ts:655`）改为 `'user' | 'session' | 'dir' | 'full' | 'stop' | 'closed' | 'away'`（`away` 是 §9.4 的到时拒绝）。
  `ToolGate` 与 `ApprovalEndBy` 的最终取值在 §12 列一次。
- **预告**：`announce(toolCallId, toolName)`（`app/src/kernel/approval.ts:156-160`）改为 `announce(toolCallId, toolName, args)`，`app/src/kernel/sessions.ts:194` 传 `tool_execution_start` 的 `event.args`；
  它用与处理器相同的判断（§6.1，不挂起、不改状态）算出 `gate`；预告时没有 `ctx`，用建 gate 时传入的 `GateOutput.cwd`（`createEntry` 的 `args.cwd`，与 `ctx.cwd` 是同一个值）。`args` 是 pi 准备参数之前的原样（`app/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:413-419`），`edit` 的旧写法归一不改 `path`，命令原样，所以通常与处理器一致。
- **更正**：处理器算出的 `gate` 与预告不同就再发一次 `mori.tool_gate`（现在只在预告 `ask`、实际不问时发，`app/src/kernel/approval.ts:181-182`）。实际是 `ask` 时界面靠随后的 `mori.approval_request` 进入等批准，更正只记下 `gate`；
  这时工具卡在 `tool_execution_start` 时已按预告标了 `Full access` 之类的标签，`applyApproval` 收到请求时把 `allowedBy` 清空（`app/src/renderer/src/state/transcript.ts:254-259` 现在只改状态），等批准时不带放行标签。
- **工具卡的标签**（`app/src/renderer/src/components/ToolCard.tsx:36-38` 的 `badgeText`、`app/src/renderer/src/state/transcript.ts:180-182` 的 `autoAllowed`、`app/src/renderer/src/state/model.ts:44` 的 `allowedBy`）：

| `gate` / `by` | 标签 |
| --- | --- |
| `session`、`dir` | `Allowed for this session` |
| `full` | `Full access` |
| `free`、`deny`、`user` | 没有 |

  原来的 `Allow all` 标签去掉。标签仍只在实时运行时显示（从会话记录载入时没有这个信息，同 `docs/v0/screens/approval.md`）。
- `app/src/renderer/src/components/IssueDialog.tsx:105` 的 `Permission mode` 写 `Full access` / `Ask each time`；操作记录（`app/src/renderer/src/state/actionLog.ts:74-81`）：`Permission mode: Full access`、
  `Permission request: Allow writes to folders for this session`（`allowDir`）、`Forget “Allow for this session”: writes to <目录>`。

### 6.15 拒绝原文与界面怎样认出

- 你拒绝、你按了停止的三种原文不变（`app/src/shared/protocol.ts:63-71`）。
- 没人能批（§6.11）时回给模型：`Denied by Mori: nobody can approve tool calls in this run, and this call <why>. Don't retry it.`，`<why>` 按目标的理由拼，几种之间用 `; `：

| 理由 | `<why>` |
| --- | --- |
| `outside` | `writes outside the working directory: <path>, <path>` |
| `protected` | `writes to a protected path: <path>` |
| `unresolved` | `writes to a path Mori can't resolve: <text>` |
| `leaves` | `runs outside the working directory: <path 或 text>` |
| `unanalyzed` | `can't be analyzed: <reason>`（§7.8 的原因） |
| scope `inside`（Ask each time 下要问的调用；现在没有会话走到这里） | `needs the user's approval` |

  每种最多列 5 个，多的写 `and <n> more`。
- **界面怎样认出**：`shared/workspace.ts` 加一张 `DENIAL_PREFIXES`，列出程序拒绝原文的固定开头（界面不能 import `kernel/`，所以放在 shared）。
  这张表只在这里说明一次，完整的一张在 §12：

| 开头 | 出处 | 工具卡 |
| --- | --- | --- |
| `Denied by Mori: ` | 本节，没人能批 | `Denied · <原文>` |
| `NARROWING_LEADS` 的五个开头各接 `: `（`Not allowed for this task: ` 等） | §8.3、§8.4，收窄 | `Denied · <原文>` |
| `RELAY_ONLY` 整句 | §8.3，协作模式下的对话会话与合并会话 | `Denied · <原文>` |
| `REJECTED_AWAY_PREFIX`（`The user was away and didn’t answer within `） | §9.4，你不在、批准卡到时 | `Denied · No answer while you were away` |
| `Mori couldn’t prepare .work in the working directory` | §7.10，`ensureWork` 失败、放行的调用被挡下 | `Denied · <原文>`，没有放行标签 |
| `ASK_DECLINED_TEXT` 整句 | §10.6，你拒绝回答提问 | `Denied · You declined to answer` |
| `ASK_STOPPED_TEXT` 整句 | §10.6，提问时你按了停止 | `Stopped`：不算拒绝，`addToolResult` 与 `ABORTED_TOOL` 一样算已停止 |
| mori-team、mori-memory 先于路径闸的拒绝：开头 `You handed off `；整句 `Only task_handoff works in this turn; call it now.`、`Only request_close works in this turn; call it now.`、`Memory files can only be changed with the memory tool or on the Memory page.`、`Enhancement runs can only change memory, with the memory tool.` | 交接后、强制填写（平行 Agent 规格 §7.1、§7.5），记忆目录写保护与增强会话的 write、edit（记忆规格 §7.7、§9.6） | `Denied · <原文>`（2026-10-27 注：负责人定） |

  `app/src/renderer/src/state/model.ts:292-297` 的 `parseRejection` 在三种你的原文之后按这张表认：以其中之一开头时返回表里的理由（前三行为原文全文），工具卡显示 `Denied · <理由>`
  （40 字截断，悬停看全文，同现在）。这样从会话记录载入（`app/src/renderer/src/state/history.ts:68`）和实时都显示 Denied。
- 实时：不出卡的拒绝没有 `mori.approval_end`，pi 只发 `tool_execution_end`（`isError`）。`state/transcript.ts` 的 `applyToolExecution` 在 `isError` 且输出被 `parseRejection` 认作程序拒绝时，
  状态记为 `rejected`、理由为原文，**并清掉 `allowedBy`**（停止中的调用仍按现在记 `stopped`）。这一条也管“预告放行、处理器放行之后又被 `ensureWork` 挡下”的调用（§7.10）：
  工具卡在 `tool_execution_start` 时已按预告标了 `Full access` / `Allowed for this session`，不另发 `mori.tool_gate { gate: 'deny' }`（卡已是 `running`，
  `applyToolGate` 不理它，`app/src/renderer/src/state/transcript.ts:206-213`），由这条规则去掉标签、记为 `Denied`。

### 6.16 身份段里的权限句

身份段第二句（`app/src/kernel/memoryText.ts:21-22`，记忆规格附录 A.1）按这次运行开始时的模式写（proposal §10“记忆规格”）。`IDENTITY_TEXT` 改为 `identityText(permission)`，
`renderIdentity(input, permission)`（`app/src/kernel/memoryText.ts:109`）多一个参数；`permission` 为 `'ask' | 'full' | 'none'`，由 `ApprovalPolicy.promptMode()` 给出（`canAsk` 为假时 `none`），
经 `MemoryExtensionSetup`（`app/src/kernel/memoryExtension.ts:50-61`）加的 `permission()` 在 `before_agent_start` 读（`writePrompt`，`:115-125`）。三种原文见 §14。

- Ask each time 的这一句与现在逐字相同（仍然准确：“may wait”）。但 §7 在每种模式下都往身份段加 `.work` 那一句，所以身份段全文在所有模式下都变了：
  MEM-01、`mem-app-prompt`、`tb-app-flow` 里逐字的身份段要改，带身份段的录制（`tests/fixtures/mem/*.json` 等）按 AGENTS.md 重录（§14 汇总）。
- 一次运行中途换模式，这次运行的身份段不变，下一次运行按新模式写；换模式后第一个请求的系统提示与前一次不同，前缀缓存失效一次。
- `.work` 的用法那一句由 §7 给，放在这一句之后、四个分节那一句之前。

## 7. 命令分析与 `.work`

本节实现 proposal §5.1 的“命令先分析出它会写到哪里”、§9 第 3 条“命令靠分析，不是沙箱”、§4 的 `.work` 一行和 §12 第 2 条
（执行前分析命令，同时把 TEMP / TMP 指到 `.work/tmp`）。分为两块：

- `kernel/commandScan.ts`（新，纯函数）：读 bash / powershell 工具的 `command` 文字，给出**认出的写入目标**和**换到工作路径外之后还在跑的命令**。
  它不分类：目标算工作路径内、`.work`、受保护路径还是外面，由 §6 的路径闸（`pathGate.ts`）判断；§8 的收窄（`limits.ts`）用同一份结果。
- `.work`：什么时候建、怎么建 `.work/`、`.work/.gitignore`、`.work/tmp`；bash / powershell 工具怎样经 `spawnHook` 把每条命令的
  TEMP、TMP、TMPDIR 指到 `.work/tmp`；身份段里告诉模型的一句。

**这不是沙箱**（proposal §5.1）：脚本和程序自己打开文件写到别处（`python build.py`、`npm i -g`、各种缓存目录），commandScan 看不到；
认不出写入的命令照常跑。§7.5 末尾列出常见的认不出的写法，规格和 Full access 的确认框（§6）都按此说明。

### 7.1 现在的代码

| 事 | 现在 | 出处 |
| --- | --- | --- |
| 命令的批准 | 只按工具名：`gateFor(toolName)` 返回 free / all / session / ask，参数不看 | `app/src/kernel/approval.ts:97-101` |
| 命令写到哪 | 不分析：`guardWrite` 只看 write、edit 的 `path`，注释写明“命令和 MCP 写什么看不出来，不检查” | `app/src/kernel/memoryExtension.ts:184-199` |
| 命令的环境 | pi 在执行时建 env：`getShellEnv()` 是 `process.env` 的副本加上 pi 的 bin 目录，再加 `PI_*`；最后交给 `spawnHook`（同步函数，可以改 command、cwd、env） | `app/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js:135-157`、`dist/utils/shell.js:115-126` |
| `spawnHook` 什么时候调用 | 工具的 `execute` 里，`tool_call` 处理器放行之后、`spawn` 之前；cwd 为 `ctx.cwd`（会话的工作路径） | `dist/core/tools/bash.js:172-174`、`:259` |
| `spawnHook` 能不能传进去 | `createBashToolDefinition(cwd, { commandPrefix, shellPath, spawnHook, … })`、`createPowerShellToolDefinition(cwd, { spawnHook, … })` 都从包入口导出；`createAgentSession` 没有直接传 `spawnHook` 的参数，只能用 `customTools` 按同名换掉内置工具 | `dist/core/tools/bash.d.ts:64-81`、`dist/core/tools/powershell.d.ts:11`、`dist/index.d.ts:26`、`dist/core/sdk.d.ts:55-56` |
| 内置工具怎样建 | `_buildRuntime` 按设置的 `shellCommandPrefix`、`shellPath` 建 bash；powershell 不带选项 | `dist/core/agent-session.js:2934-2946`、`dist/core/tools/index.js:89-99` |
| Mori 建会话 | `createAgentSession` 不传 `customTools`，bash、powershell 是 pi 的内置工具 | `app/src/kernel/sessions.ts:426-428` |
| PowerShell 用哪个 | 先 `pwsh.exe`（7），没有时 `powershell.exe`（5.1）；参数 `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command` | `dist/utils/shell.js:103-114` |
| `.work` | 没有 | — |

### 7.2 `commandScan.ts` 的接口

```ts
/** @brief commandScan 的输入。 */
export interface ScanInput {
  /** bash / powershell 工具的 command 参数（tool_call 里 pi 校验后的 event.input.command） */
  command: string;
  /** 哪个工具：'bash' 按 Git Bash 的语法，'powershell' 按 PowerShell 的语法 */
  shell: 'bash' | 'powershell';
  /** 会话的工作路径（ctx.cwd，绝对 Windows 路径）；相对路径从这里开始解析 */
  cwd: string;
  /** Mori 知道值的变量：TEMP、TMP、TMPDIR → <cwd>\.work\tmp（workVars(cwd)，与 spawnHook 设的值相同，§7.11） */
  vars: Readonly<Record<string, string>>;
}

/** @brief 目标看不出来的原因（§7.6）。 */
export type UnknownWhy = 'variable' | 'home' | 'glob' | 'substitution' | 'input' | 'shell-path'
  | 'drive-relative' | 'provider' | 'parameter' | 'directory';

/** @brief 一个认出的写入目标。 */
export interface ScanWrite {
  /** 认出它的写法。重定向写操作符原样，含紧挨的 fd 数字（'>'、'>>'、'2>'、'2>>'、'3<>'、'&>'、'&>>'、'>|'、'>&'、'*>'、'*>>'；
   *  bash 的 '{名字}>' 记作 '>'）；命令写 'tee'、'cp'、'mv'、'rm'、'rmdir'、'mkdir'、'touch'、'ln'、'sed -i'、'Set-Content'、
   *  'Add-Content'、'Out-File'、'Tee-Object'、'New-Item'、'Copy-Item'、'Move-Item'、'Remove-Item'、'Rename-Item'（cmdlet 用全名，不用别名） */
  form: string;
  /** 命令里的原文（去掉引号与转义后）；批准卡的 targets 显示它。命令里没写出的目标写解析时用的那一段：
   *  Copy-Item / Move-Item 没有 Destination 时为 '.'，ln 只有一个操作数时为它的文件名，New-Item 只有 Name 时为 Name，
   *  Rename-Item 的新名字为 NewName；看不出来的补出目标见 §7.6 */
  text: string;
  /** 解析后的绝对路径（path.win32.resolve 规范化）；看不出来时为 null，§6 按写到外面处理 */
  path: string | null;
  /** path 为 null 的原因；看得出来时为 null */
  unknown: UnknownWhy | null;
  /** 删除或移走：rm、rmdir、Remove-Item 的目标，mv / Move-Item 的源，Rename-Item 的原名（§6 据此认“删掉工作路径本身”） */
  remove: boolean;
  /** 从命令文字就看得出东西落在 path 这个目录里面（§7.5“落进目录”）；§6 的按目录放行据此取 path 本身而不是它的上级。
   *  path 为 null 或 remove 为真时为 false */
  into: boolean;
}

/** @brief 换过目录（当前目录不是工作路径本身，或看不出在哪）之后还跑了一条不是只读的命令（§7.7）；在不在工作路径里由 §6 按真实路径判断。 */
export interface ScanLeave {
  /** 换目录的写法：'cd'、'pushd'、'popd'、'Set-Location'、'Push-Location'、'Pop-Location'、'git -C'、'--git-dir'、
   *  '--work-tree'、'GIT_DIR'、'GIT_WORK_TREE' */
  form: string;
  /** 目录的原文（cd 没有参数时为 '~'） */
  text: string;
  /** 解析后的目录（字面，不跟链接）；看不出来时为 null */
  dir: string | null;
  /** 在那里跑的命令：git 写 'git <子命令>'，cmdlet 写全名，其他写去掉路径和 .exe 的名字（例如 'npm'） */
  command: string;
}

/** @brief 分析结果。ok 为假时整条命令按写到外面处理（§7.8）。 */
export type ScanResult =
  | { ok: true; writes: ScanWrite[]; leaves: ScanLeave[] }
  | { ok: false; reason: string };

/** @brief 分析一条命令（纯函数：不读文件、不读环境变量、不看系统，只看参数；不接受回调）。 */
export function scanCommand(input: ScanInput): ScanResult;
```

- **谁调用**：§6 的路径闸在 `tool_call` 里对 bash、powershell 调用 `scanCommand({ command, shell: toolName, cwd: ctx.cwd, vars: workVars(ctx.cwd) })`；
  `announce`（`tool_execution_start` 之前预告卡片状态）用原始参数再算一次。分析的时间与命令长度成正比（嵌套的文字每层再扫一遍，最多 32 层，§7.8），算两次不用缓存。
- **结果怎么用**（§6、§8 定，这里只列出约定）：`writes` 里每一项按 path 分类，path 为 null 算外面；`leaves` 每一项由 §6 按真实路径判断，`dir` 在工作路径里的丢掉，其余算外面；
  `ok: false` 算外面（§6.4 的理由 `unanalyzed`，卡上一行 `Couldn’t analyze this command: <reason>`）。
  `remove` 为真且 path 是工作路径本身或它的上级时，§6 按受保护路径（“删掉工作路径本身也算”）。
  `into` 为真时，写到外面的卡上“Allow writes to <目录> for this session”的目录取 path 本身（`cp x ../bk/` 放行 `../bk`），为假时取 path 的上级（proposal §13 第 1 条）。
- **顺序与去重**：`writes`、`leaves` 按命令文字里出现的顺序（嵌套的文字在它出现的位置展开）；form、text、path、remove 都相同的写入只留第一个，
  form、text、dir、command 都相同的 leave 只留第一个（2026-10-27 注：负责人定：原来不看 dir，会把换到别处的第二次 leave 去掉）。
- **路径的写法**：一律按 Windows（`path.win32`），不随测试机器变；判断当前目录是不是工作路径本身（§7.7）用 §6 `pathGate.ts` 的路径比较（`path.win32.relative` 为空；
  不分大小写、统一 `/` 与 `\`）。只做字面解析，不跟链接：换过目录之后在不在工作路径里由 §6.4 按真实路径判断，commandScan 不判断。不调用 §6 的 `resolveToCwd`：它按 `process.platform` 换 `/c/…`、按 `homedir()` 展开 `~`，不是纯函数；
  commandScan 自己按 §7.6 解析，`/c/…` 的换法与它相同，`~` 按看不出来。
- **不分析的部分**：pi 设置里的 `shellCommandPrefix` 是你自己的配置，pi 在执行时加在命令前面（`bash.js:173`），不分析；PowerShell 工具在执行时加的
  UTF-8 输出前缀（`powershell.js:4`，在 `:12` 的 `exec` 里加上，`spawnHook` 之后）同样不算。
- **文件**：入口和类型在 `commandScan.ts`。超过 2000 行时按 shell 拆出 `commandScanBash.ts`、`commandScanPs.ts`，入口不变。

### 7.3 切分与结构

分析分三步：词法（切成词和操作符，记下引号）、语法（拼成命令列表和复合结构）、逐条简单命令按执行顺序处理（§7.4–§7.7）。
**结构词从宽，引号与括号从严**：缺了 `fi`、`done`、`esac`、bash 的 `}` 的结构到文字末尾自动结束；引号、`(`、`$(`、`` ` ``、`${`、
PowerShell 的 `{` 没有闭合是解析失败（§7.8）。

#### Git Bash

| 规则 | 写法 |
| --- | --- |
| 分词 | 空格、tab、`\r` 分词；换行是分隔符（here-doc 正文另算）；`\r\n` 当换行（bash 自己把 `\r` 当普通字符，`touch a\r` 建的是 `a` 加一个 `\r`；这里当空白，目标所在的目录不变） |
| 单引号 | 到下一个 `'`，原样 |
| 双引号 | `\` 只转义 `$`、`` ` ``、`"`、`\`、换行，其余 `\` 原样保留（所以 `"C:\Users\x"` 是 `C:\Users\x`）；`$…`、`` `…` `` 照样展开 |
| `$'…'`、`$"…"` | 前者按 bash 的 ANSI-C 转义还原；后者同双引号 |
| 引号外的 `\` | `\x` → `x`（所以不加引号的 `C:\x` 是 `C:x`，§7.6）；`\` 加换行是续行，两个字符都去掉 |
| 注释 | 引号外、词首的 `#` 到行尾 |
| 控制操作符（最长匹配） | `;;&` `;;` `;&` `&&` `\|\|` `\|&` `;` `\|` `&` `(` `)` 换行 |
| 重定向操作符 | `[n]>` `[n]>>` `[n]>\|` `&>` `&>>` `[n]>&` `[n]<` `[n]<<` `[n]<<-` `[n]<<<` `[n]<>` `[n]<&`；`n` 是紧挨的数字或 `{名字}`。操作符和目标之间可以有空白 |
| 展开 | `$NAME`、`${…}`、`$(…)`、`` `…` ``、`$((…))`、`<(…)`、`>(…)`；`$(…)`、`` `…` ``、`<(…)`、`>(…)` 的内容递归按命令分析；`$((…))` 的内容不分析 |
| here-doc | `<<词`、`<<-词`；词里有引号时正文原样，没有时正文里的 `$(…)`、`` `…` `` 照样分析。正文从这一行末尾的下一行开始，到只有这个词的一行（`<<-` 先去掉行首的 tab）为止；一行里几个 here-doc 依次取。没有结束行时正文到文字末尾（同 bash，只警告） |
| here-string | `<<<` 后面的词是输入，不是目标 |
| 列表 | 管道 `a \| b`、`a \|& b`；列表用 `;`、`&`、`&&`、`\|\|`、换行连接；`!`、`time [-p]` 放在管道前 |
| 复合结构 | `( 列表 )`（子 shell）、`{ 列表; }`、`if/then/elif/else/fi`、`while/until … do … done`、`for/select 名字 [in 词…] ; do … done`、`for ((…))`、`case 词 in 模式) 列表 ;; … esac`（模式可以以 `(` 开头，用 `\|` 分隔，结束于 `;;`、`;&`、`;;&`）、函数定义 `名字() 复合结构`、`function 名字 [()] 复合结构`。函数体当作会被执行，就地分析 |
| 复合结构后的重定向 | `}`、`)`、`fi`、`done`、`esac` 后面的重定向作用于整个结构，照样记写入（`if …; fi > log`） |
| `[[ … ]]`、`(( … ))` | 里面的 `<`、`>` 是比较，不是重定向；`[[ ]]` 里的 `$(…)` 照样分析。`[ a > b ]` 里的 `>` 是重定向（bash 就是这样） |
| `for` 的词表、`case` 的词与模式 | 不是目标；里面的命令替换照样分析 |
| 保留字 | `if then elif else fi do done while until for select case esac in function { } ! time [[ ]] coproc` 只在命令的位置算保留字 |

#### PowerShell

| 规则 | 写法 |
| --- | --- |
| 分词 | 空格、tab、`\r` 分词；换行、`;` 是语句分隔符 |
| 单引号 | 原样，`''` 是一个 `'` |
| 双引号 | 可展开：`` ` `` 转义（`` `n ``、`` `t `` 等换成字符，`` `$ `` 是 `$`），`""` 是一个 `"`；`$名字`、`${…}`、`$(…)` 展开，`$(…)` 的内容递归分析 |
| 弯引号 | `‘ ’ ‚ ‛` 同 `'`，`“ ” „` 同 `"`（PowerShell 也这样认） |
| here-string | `@'` 换行 … 换行 `'@` 原样；`@"` … `"@` 可展开（`$(…)` 照样分析） |
| 引号外的 `` ` `` | 转义下一个字符；`` ` `` 加换行是续行 |
| 注释 | 词首的 `#` 到行尾；`<# … #>` |
| 操作符 | `\|`、`&&`、`\|\|`（7 才有；5.1 报语法错，同样当分隔符）、`;`、语句开头的 `&`（调用）与 `.`（点源）、语句末尾的 `&`（7 的后台作业）、`(`、`)`、`{`、`}`、`@(`、`$(`、`@{`、`,`（数组）、`=` `+=` 等（赋值） |
| 重定向操作符 | `>` `>>` `n>` `n>>`（n 为 1–6）`*>` `*>>`；`n>&1`、`n>&2`、`*>&1` 是合并，不是目标；`<` 在 PowerShell 里是保留的、整段脚本不运行 → 解析失败（§7.8） |
| `--%` | 解析失败（§7.8 的 `stop-parsing token`）：之后到行尾的文字原样交给程序，程序是 `.cmd` / `.bat` 垫片时由 cmd.exe 再解析一遍，`>`、`\|`、`&` 又成了重定向与命令连接（pwsh 7.6 实测 `npm.cmd --version --% > ..\x` 写出了文件） |
| 语句 | 关键字语句（`if elseif else switch foreach for while do until try catch finally trap function filter param begin process end return throw break continue exit class enum`）：跳过关键字，`( … )` 按管道分析，`{ … }` 按语句列表分析；赋值 `左值 = 管道`；其余是管道 |
| 管道的一节 | 以裸词、`&`、`.` 开头是**命令**；以 `$`、引号、数字、`(`、`[`、`@` 开头是**表达式**。表达式不是命令，但其中的 `$( )`、`@( )`、`( )`、脚本块 `{ }` 照样分析 |
| 脚本块 | 任何地方的 `{ … }`（`ForEach-Object { }`、`Invoke-Command -ScriptBlock { }`、`& { }`）都当作会被执行，就地分析；`@{ … }` 哈希表的值同样分析 |
| 作用域 | Set-Location 的效果一直延续：括号、脚本块、`& { }` 都不隔开（PowerShell 的位置是整个运行空间的，本机 7.6 实测） |

### 7.4 命令名、前缀与嵌套

一条简单命令先去掉前缀，找出真正的命令名，再按 §7.5、§7.7 处理。

**bash 的前缀**

| 写法 | 处理 |
| --- | --- |
| 开头的赋值 `名字=值`（可以几个） | 不是命令；值里的命令替换照样分析。其中 `TEMP=`、`TMP=`、`TMPDIR=`、`PWD=`（任何值）让这个名字在这条简单命令里看不出来（`variable`），包括它经包装、嵌套 shell（`bash -c`、`pwsh -c`、`eval`、`xargs`、`find -exec`）时里面分析的全部文字（偏严：bash 先展开本条命令的词再放入临时赋值，严格说只有嵌套文字看到新值；`PWD` 会被子 bash 重设，一并算只是多问）；`CDPATH=` 见表下的 CDPATH 一条；`GIT_DIR=`、`GIT_WORK_TREE=` 只作用于这一条命令（§7.7）。只有赋值、没有命令时是 shell 变量赋值：`TEMP`、`TMP`、`TMPDIR`、`PWD` 从此看不出来；`GIT_DIR`、`GIT_WORK_TREE` 按 export 处理（偏严） |
| `export`、`declare -x`、`local`、`readonly`、`typeset` 带 `名字=值` | 同上一行“只有赋值”（`CDPATH=` 同样见表下）；`unset 名字` 清掉 `GIT_DIR` / `GIT_WORK_TREE` |
| `read 名字…`、`for 名字 in …`、`select 名字 in …` 用到 `TEMP`、`TMP`、`TMPDIR`、`PWD` | 这个名字从此看不出来 |
| 包装命令 | 去掉它和它的选项，后面的词是真正的命令（见下表） |
| 命令名有看不出来的部分（`$CC -o out main.c`、`"$(which tool)" x`） | 解析失败（the command name comes from a variable or substitution）。命令名是已知变量（`$TMPDIR/x.sh`）时照常 |
| 命令名带路径或 `.exe` | 比较名字时去掉路径和 `.exe`（`/usr/bin/rm`、`rm.exe` 都是 `rm`） |
| 命令名的大小写 | 一律不分大小写比较：Windows 的文件系统不分，Git Bash 按 PATH 找外部程序时 `RM`、`Cp` 跑的就是 `rm`、`cp`（本机实测 `RM --version`）。bash 的内建命令其实区分（`CD ..` 报 command not found），按不分算只会多问。§7.3 的保留字仍区分大小写（`IF` 不是 `if`） |

**CDPATH**：bash 的 `cd` / `pushd` 对不以 `/`、`.`、`..` 开头的操作数先查 CDPATH，CDPATH 里的目录优先于当前目录（Git Bash 实测 `CDPATH=<外面> cd evil` 换到了外面）。
命令里出现 `CDPATH=`（开头的赋值、`export` 这类、`env` 的 `名字=值`，或 PowerShell 的 `$env:CDPATH = …`）之后，这条命令（含之后嵌套的 bash 文字）里
bash 的 `cd` / `pushd` 操作数不以 `/`、`\`、`.`、`~`、盘符开头时目录看不出来（text 为操作数）；`unset CDPATH` 不恢复（偏严）。
用户环境里本来就有的 CDPATH 由 `workEnv` 去掉（§7.11），所以没有这些写法时照 §7.7 按当前目录解析。

**包装命令**

| 包装 | 跳过的选项 | 之后 |
| --- | --- | --- |
| `env` | `-i` `-0` `--ignore-environment` `--null`；带值 `-u` `--unset`；然后的 `名字=值` 同开头的赋值（含 `CDPATH=`）。`-i`、`--ignore-environment` 让 TEMP、TMP、TMPDIR、PWD 在这条命令（含嵌套文字）里都看不出来（Git Bash 实测 `env -i bash -c '… "$TMPDIR/x"'` 写到了 `C:\Program Files\Git\x`）；`-u` / `--unset` 的值是这四个名字之一时同样。`-C` `--chdir` `-S` `--split-string` 解析失败（unsupported option） | 真正的命令；没有命令时只打印，算只读 |
| `command` | `-p`；`-v`、`-V` 只打印，没有命令 | 真正的命令 |
| `builtin`、`nohup`、`time` (`-p`) | — | 真正的命令 |
| `exec` | `-c` `-l`；带值 `-a` | 真正的命令；只有重定向时（`exec > log`）记重定向 |
| `nice` | 带值 `-n`；`-数字` | 真正的命令 |
| `timeout` | `--preserve-status` `--foreground` `-v`；带值 `-s` `-k` `--signal` `--kill-after`；然后一个时长 | 真正的命令 |
| `xargs` | `-0 -o -p -r -t -x` 等；带值 `-a -d -E -I -L -n -P -s` 与对应的长选项；`-i[替换串]`、`-e[结束串]`、`-l[数]` 的值只能紧挨 | 真正的命令；没有命令时是 `echo`。输入的项：有 `-I`、`-i`、`--replace` 时，含替换串的词看不出来（`input`）；没有时在操作数末尾补一个看不出来的操作数（`input`），所以 `xargs cp ../x` 的目标看不出来，`xargs cp -t ../bk` 的目标是 `../bk` |
| `find … -exec`、`-execdir`、`-ok`、`-okdir` | 从这个词到 `;`（`\;` 或 `';'`）或 `+` 之间是一条命令 | 这条命令照常分析；其中的 `{}` 看不出来（`input`）。`find` 自己不是写法（`-delete`、`-fprint` 认不出，§7.5 末尾） |

**嵌套的 shell 与 eval**：文字按对应 shell 的规则分析，起点是当时的当前目录；嵌套的 shell（`bash -c`、`pwsh -c` 等）里的 `cd` 不影响外面，
`eval`、`Invoke-Expression`（`iex`）与真实的 shell 一样在同一个 shell 里跑，里面的 `cd` 延续到后面（2026-10-27 注：负责人定，原写 eval 里的 `cd` 也不影响外面）；写入和 leave 合进外面的结果。
嵌套文字继承外面当时“看不出来的变量”集合（TEMP、TMP、TMPDIR、PWD，与是否设过 CDPATH），两种 shell 之间也继承（PowerShell 的 `$env:` 名字不分大小写）：
`export TMPDIR=..` 之后的 `bash -c '… $TMPDIR …'`、`$env:TEMP = 'x'` 之后的 `pwsh -c '… $env:TEMP …'` 或 `bash -c '… $TEMP …'` 里的目标都按 `variable`
（Git Bash 与 pwsh 7.6 实测这些写法都写到了工作路径外）。

| 写法 | 处理 |
| --- | --- |
| `bash`、`sh`（含路径、`.exe`）`[选项] -c 文字 [参数…]` | `-c` 可以在组合里（`-lc`、`-ec`、`-euxc`）；`-o`、`-O`、`+o` 带值；文字按 bash 分析 |
| `bash`、`sh` 没有 `-c` 也没有脚本 | 读标准输入：here-doc（引号词）或 here-string 的正文按 bash 分析；正文有展开、或从管道读（`curl … \| bash`）→ 解析失败（the command text comes from a variable or input） |
| `bash script.sh`、`source 文件`、`. 文件` | 跑脚本，不分析（同 `python x.py`） |
| `powershell`、`pwsh`（含路径、`.exe`）`-Command` / `-c` 文字… | 选项不分大小写，可以用 `-` 或 `/`，可以用唯一前缀（`-Comm`）。其余参数用空格连起来按 PowerShell 分析。开关：`-NoProfile -NonInteractive -NoLogo -NoExit -Interactive -Login -MTA -STA`；带值：`-ExecutionPolicy -WindowStyle -OutputFormat -InputFormat -Version -ConfigurationName -SettingsFile -CustomPipeName -PSConsoleFile` |
| `-File` / `-f`；pwsh 的第一个位置参数 | 跑脚本，不分析 |
| powershell.exe（5.1）的位置参数 | 同 `-Command` |
| `-EncodedCommand`、`-enc`、`-e`、`-ec` | 解析失败（encoded command） |
| `-WorkingDirectory`、`-wd`、其他不认识的选项 | 解析失败（unsupported option `<选项>`） |
| `-Command -`，或没有命令也没有文件 | 同 bash 的“读标准输入” |
| `eval 词…` | 词用空格连起来按 bash 分析；有看不出来的部分 → 解析失败 |
| `trap 动作 信号…` | 动作按 bash 分析；`trap -p`、`trap -l`、`trap - 信号`、`trap '' 信号` 不分析；动作有看不出来的部分 → 解析失败 |
| `Invoke-Expression` / `iex [-Command] 文字` | 按 PowerShell 分析；文字不是字面量（`iex $s`、`iex (Get-Content s.ps1 -Raw)`）→ 解析失败 |
| PowerShell 的 `& 文字`、`& { 块 }`、`& $变量` | 字面量的命令名照常；块就地分析；变量或子表达式 → 解析失败（the command name comes from a variable or substitution） |
| PowerShell 的 `.\x.ps1`、`. .\x.ps1`、`& .\x.ps1` | 跑脚本，不分析 |
| `cmd /c`、`python -c`、`node -e`、`wsl`、`ssh`、`docker` | 不分析：不是认得出的写法，照常跑 |

**PowerShell 的命令名**：不分大小写；去掉模块限定（`Microsoft.PowerShell.Management\Remove-Item`）和 `.exe`；先按别名换成 cmdlet 全名（§7.5）。
`sed`、`touch`、`ln` 在 PowerShell 里不是别名，是外部程序，PowerShell 一侧不认它们（§7.5 末尾）。

**PowerShell 里外部程序的参数**：命令不是 cmdlet、别名、函数、关键字（外部程序，含 `& 名字` 调用；纯函数不查系统，所以名字是 `动词-名词` 形状（恰好一个 `-`，两边都是字母）、
是 §7.5 或 §7.7 名单里的别名、或是这条命令里定义的函数时算 cmdlet 与函数，以 `.ps1` 结尾的脚本在 PowerShell 里运行、也不算，其余都算外部程序）时，某个参数去掉 PowerShell 引号后不含空白、却含 `>`、`<`、`|`、`&` 之一
→ 解析失败（§7.8 的 `cmd.exe metacharacter in an argument`）。程序是 `.cmd` / `.bat` 垫片时 PowerShell 把这样的参数不带引号传过去，cmd.exe 再解析一遍，
它们又成了重定向与命令连接（pwsh 7.6、`$PSNativeCommandArgumentPassing = Windows` 实测：`npm.cmd --version '>' ..\x` 写出了 `..\x`）；含空白的参数 PowerShell 带引号传递，
cmd.exe 不再解析，照常。Mori 看不出命令名会解析成 .exe 还是 .cmd 垫片（裸词 `npm` 在本机解析成 `npm.ps1`，`npm.cmd`、`code`、`gradlew` 解析成 .cmd），所以按文字从严；
原生 .exe 收到 `'>'` 时并不写文件（`where.exe cmd '>' x`），同样算失败，只是多问一次。`--%` 见 §7.3。

### 7.5 认得出的写法

proposal §5.1 列的写法（`>`、`>>`、`tee`、`cp`、`mv`、`rm`、`mkdir`、`sed -i`、`Copy-Item`、`Move-Item`、`Remove-Item`、`Set-Content`、`Out-File`），
加上 Claude 不经沙箱检查 shell 写入时认的 `touch`、`rmdir`（Claude 的 Accept edits 自动接受的文件命令是 mkdir、touch、rm、rmdir、mv、cp、sed，
重定向与 `tee` 另查，见 https://code.claude.com/docs/en/permission-modes 与 https://code.claude.com/docs/en/permissions#redirections）；
`ln` 与 `touch` 同类（建一个新的目录项）；PowerShell 一侧补上同类的 `Add-Content`（`>>`）、`New-Item`（mkdir、touch）、`Rename-Item`（mv）、`Tee-Object`（tee）。
名单以外的写法不认，照常跑。

#### Git Bash

**重定向**（任何简单命令和复合结构上都认，出现在命令名之前也算：`> out echo hi`）

| 写法 | 目标 |
| --- | --- |
| `>` `>>` `>\|` `n>` `n>>` `n>\|` `&>` `&>>` `<>` `n<>` `{名字}>` | 后面的词 |
| `>&词`、`n>&词`（词不是数字也不是 `-`） | 后面的词（同 `&>`） |
| `n>&m`、`n>&-`、`n<&m`、`<`、`<<`、`<<-`、`<<<` | 不是写入 |
| 目标是 `/dev/null`、`/dev/stdout`、`/dev/stderr`、`/dev/stdin`、`/dev/tty`、`/dev/fd/<n>` | 不是写入（这条对 `tee`、`cp` 等的操作数也一样） |
| 目标是 `>(…)` / `<(…)` | 不是文件目标；括号里的命令照常分析 |

**命令**（GNU 选项：短选项可以组合，`-rf` 是 `-r -f`；组合里遇到带值的字母，组合剩下的部分是它的值，没剩下时取下一个词；
`--` 之后都是操作数；不认识的选项当作不带值。带值的长选项写 `--x=v` 或 `--x v`；表里“只用 `=`”的长选项只认 `--x=v`）

| 命令 | 带值的选项 | 只用 `=` 的长选项 | 目标 |
| --- | --- | --- | --- |
| `tee` | — | `--output-error` | 每个操作数 |
| `cp` | `-t` `-S`、`--target-directory` `--suffix` `--sparse` `--no-preserve` | `--backup` `--reflink` `--preserve` `--context` | 有 `-t` 时为它；否则最后一个操作数（只有一个操作数时没有目标）。源不是目标 |
| `mv` | `-t` `-S`、`--target-directory` `--suffix` | `--backup` `--context` | 每个源（`remove`）加上目标（同 `cp`） |
| `rm` | — | `--interactive` `--preserve-root` | 每个操作数（`remove`） |
| `rmdir` | — | — | 每个操作数（`remove`；`-p` 删掉的上级都在操作数的路径上，不另列） |
| `mkdir` | `-m`、`--mode` | `--context` | 每个操作数 |
| `touch` | `-d` `-r` `-t`、`--date` `--reference` `--time` | — | 每个操作数（`-r` 的值不是目标） |
| `ln` | `-t` `-S`、`--target-directory` `--suffix` | `--backup` | 有 `-t` 时为它；两个以上操作数时最后一个；只有一个操作数时是当前目录下与它同名的文件（GNU ln 的第二种用法） |
| `sed`（有 `-i` 或 `--in-place` 时才算写入） | `-e` `-f` `-l`、`--expression` `--file` `--line-length`；`-i` 的后缀只能紧挨（`-i.bak`，组合里 `i` 之后的都是后缀：`-ni` 是 `-n -i`，`-in` 是后缀为 `n` 的 `-i`） | `--in-place` | 文件操作数：没有 `-e`、`-f` 时第一个操作数是脚本，不算；`-f` 的值不是目标 |

带值与只用 `=` 的分法照本机 Git 带的 GNU coreutils 8.32（`cp --sparse always a b` 把 `always` 当值；`--update` 在 8.32 里不带值）。

**落进目录**（`into`，只看文字，不读文件系统）：`cp`、`mv`、`ln` 的 `-t` / `--target-directory` 的值；`cp`、`mv`、`ln` 有两个以上的源时的最后一个操作数；
这三个命令的目标以 `/` 或 `\` 结尾，或最后一段是 `.`、`..`。其余的目标（`cp a ../b` 里的 `../b` 可能是已有的目录）为 false，§6 按 path 的上级放行，偏宽一级。

#### PowerShell

**重定向**：`>` `>>` `n>` `n>>`（n 为 1–6）`*>` `*>>` 后面的词；`$null` 不是写入；`n>&1` 等合并不是写入。
PowerShell 在表达式里也认重定向：`if ($a > 5) { }` 会写文件 `5`（本机 7.6 实测），照样记写入。

**cmdlet**（参数表取 5.1 与 7 的并集，本机 `Get-Command` 读出；不分大小写）

| cmdlet | 别名 | 目标参数（位置） | 其余带值的参数 | 目标 |
| --- | --- | --- | --- | --- |
| `Set-Content` | `sc`（只有 5.1） | `Path`（0）、`LiteralPath`（`PSPath`、`LP`） | `Value`（1）、`Filter` `Include` `Exclude` `Credential` `Encoding` `Stream` | Path / LiteralPath |
| `Add-Content` | `ac` | 同上 | 同上 | 同上 |
| `Out-File` | — | `FilePath`（0，7 有别名 `Path`）、`LiteralPath`（`PSPath`、`LP`） | `Encoding`（1）、`Width`、`InputObject` | FilePath / LiteralPath |
| `Tee-Object` | `tee` | `FilePath`（0，7 有别名 `Path`）、`LiteralPath`（`PSPath`、`LP`） | `InputObject`、`Encoding`（只有 7）、`Variable` | FilePath / LiteralPath；只有 `-Variable` 时不是写入 |
| `New-Item` | `ni`；`mkdir`、`md`（目录） | `Path`（0） | `Name`、`ItemType`（`Type`）、`Value`（`Target`）、`Credential` | 每个 Path；有 `Name` 时为 Path\Name；只有 `Name` 时为当前目录\Name。`-ItemType SymbolicLink -Target x` 写的是 Path，不是 x |
| `Copy-Item` | `cp` `copy` `cpi` | `Destination`（1） | `Path`（0）、`LiteralPath`、`Filter` `Include` `Exclude` `Credential` `FromSession` `ToSession` | Destination；没有时为当前目录 |
| `Move-Item` | `mv` `move` `mi` | `Path`（0）、`LiteralPath`；`Destination`（1） | `Filter` `Include` `Exclude` `Credential` | 每个源（`remove`）加上 Destination（没有时为当前目录） |
| `Remove-Item` | `rm` `del` `erase` `rd` `ri` `rmdir` | `Path`（0）、`LiteralPath` | `Filter` `Include` `Exclude` `Credential` `Stream` | 每个 Path / LiteralPath（`remove`） |
| `Rename-Item` | `ren` `rni` | `Path`（0）、`LiteralPath`；`NewName`（1） | `Credential` | 原名（`remove`）加上“原名所在目录\NewName” |

参数规则：

- 开关（不带值）：`Force` `Recurse` `PassThru` `NoNewline` `Append` `NoClobber`（`NoOverwrite`）`AsByteStream` `Container`，以及通用参数 `Verbose` `Debug` `WhatIf` `Confirm` `UseTransaction`；
  通用的带值参数：`ErrorAction` `WarningAction` `InformationAction` `ProgressAction` `ErrorVariable` `WarningVariable` `InformationVariable` `OutVariable` `OutBuffer` `PipelineVariable`（连同它们的别名 `-ea` `-wa` 等）。
  开关可以写 `-Force:$false`。`-WhatIf` 不特别处理，照样算写入。
- 参数名：在这个 cmdlet 的参数（上表与开关）和通用参数里，先按全名和别名精确匹配，再按全名的唯一前缀匹配（`-Dest` 是 Destination，`-Rec` 是 Recurse）。值可以写 `-Path:x` 或 `-Path x`。
- 落进目录（`into`）：`Copy-Item`、`Move-Item` 没有 Destination 时的当前目录，Destination 以 `/` 或 `\` 结尾或最后一段是 `.`、`..` 时；其余为 false。
- 值可以是数组：`a,b,..\c`（逗号前后可以有空白），每一项一个目标。
- 位置参数按上表的位置依次绑定。
- **看不出来的参数**（`parameter`）：参数名不认识或有歧义（`rm -rf build`、`Set-Content -P a x`）、多出位置参数（`Remove-Item a b`）、用 splatting（`Copy-Item @p`）——
  这条命令只出一个目标：path 为 null、`unknown: 'parameter'`。PowerShell 遇到这些多半会报错不执行，这里不赌它（§7.8 的同一理由）。
- **从管道来的目标**（`input`）：目标参数没有给（Copy-Item、Move-Item 的 Destination 与 New-Item 的“只有 Name”除外）——例如 `Get-ChildItem *.tmp | Remove-Item`——出一个 path 为 null 的目标。

#### 认不出的写法（照常跑，不问）

写进规格与 Full access 的确认框说明（§6）的例子：脚本和程序（`python x.py`、`node x.js`、`npm install`、`npm i -g`、`pip install`）、
`git clone`、`git worktree add`、`git archive -o`、`curl -o`、`wget -O`、`tar -x`、`unzip`、`dd of=`、`install`、`rsync`、`find -delete`、`find -fprint`、`sort -o`、`make -C`、`tar -C`、
`cmd /c`、PowerShell 里的外部 `sed`、`touch`、`ln`，以及 `Invoke-WebRequest -OutFile`、`Export-Csv`、`Clear-Content`、`Set-Item`、`New-TemporaryFile`、`Start-Process`、
.NET 方法（`[IO.File]::WriteAllText(...)`）。§7.13 的语料统计之后再决定名单要不要加（proposal §14）。
`.cmd` / `.bat` 垫片的参数由 cmd.exe 再解析，Mori 只按文字从严拦下含元字符的参数与 `--%`（§7.4、§7.8）。

### 7.6 目标的解析与看不出来的目标

每个目标按“当前目录”解析（§7.7；开始时是工作路径）。看不出来的目标 path 为 null，`unknown` 写原因，§6 按写到外面处理（proposal §5.1）。

| 写法 | Git Bash | PowerShell | 结果 |
| --- | --- | --- | --- |
| 相对路径 `a/b`、`.\a`、`..\a` | 是 | 是 | 当前目录 + 它；当前目录看不出来时为 null（`directory`） |
| 盘符绝对路径 `C:/x`、`C:\x`（引号里） | 是 | 是 | 它自己 |
| 盘符相对 `C:x`（含 bash 里不加引号的 `C:\x` 去掉转义后） | 是 | 是 | null（`drive-relative`） |
| `/c/x`、`/cygdrive/c/x`、`/mnt/c/x` | 是 | — | `C:\x`（同 pi 的 `resolveToCwd`） |
| 其他 `/…`（`/tmp/x`、`/usr/bin`、`/etc`） | 是 | — | null（`shell-path`）：msys 根下的路径。本机实测 Git Bash 的 `/tmp` 是 `C:\Users\<你>\AppData\Local\Temp`，不跟 TMP 走（§7.11），所以不当作 `.work/tmp` |
| 以 `\` 开头、不是 UNC（bash 里要在引号中：`'\x'`） | 是 | 是 | 当前目录所在盘的根下（本机实测 Git Bash 里 `cat '\Windows\win.ini'` 读的是 `C:\Windows\win.ini`；同 `path.win32.resolve`） |
| 以 `/` 开头、不是 UNC | 见上面两行 | 是 | 当前目录所在盘的根下 |
| UNC `//server/share/x`、`\\server\share\x` | 是 | 是 | 它自己 |
| `~`、`~/x`、`~\x` 在路径开头（bash：不在引号里，`~user` 同样；PowerShell：引号里也算，`~` 由提供程序展开，本机实测 `Resolve-Path '~'` 是用户目录） | 是 | 是 | null（`home`）：proposal §5.1 把 `~` 列为看不出来，照 Claude |
| 已知变量 `$TEMP` `$TMP` `$TMPDIR` `${TEMP}`（bash 区分大小写）；`$env:TEMP` `$env:TMP` `$env:TMPDIR` `${env:TEMP}`（PowerShell 不分大小写） | 是 | 是 | `vars` 里的值（`<工作路径>\.work\tmp`）；同一条命令里先被赋过值（`export TMPDIR=..`、`$env:TEMP = 'x'`）之后为 null（`variable`，含之后嵌套文字里的引用；开头的赋值、`env -i` / `-u` 见 §7.4） |
| `$PWD`、`${PWD}`（PowerShell 的 `$pwd` 同样） | 是 | 是 | 当前目录（当前目录看不出来时为 null） |
| 其他变量：`$OUT`、`$HOME`、`$1`、`$@`、`${x:-y}`、`$env:USERPROFILE`、`$x.y`、`$x[0]` | 是 | 是 | null（`variable`）。`$HOME` 与 `~` 同值，一样算看不出来 |
| 命令替换与子表达式：`$(…)`、`` `…` ``、`$((…))`、PowerShell 的 `$(…)` `@(…)` `(…)` 做参数值 | 是 | 是 | null（`substitution`）；里面的命令照常分析 |
| 通配符：不在引号里的 `*` `?` `[`、bash 的 `{a,b}` `{1..3}` | 是 | `*` `?` `[` 在 `LiteralPath` 以外的参数里（引号里也算） | null（`glob`）；`LiteralPath` 的值按字面 |
| PowerShell 的提供程序路径：两个字母以上的驱动器（`Env:` `HKCU:` `HKLM:` `Function:` `Variable:` `Alias:` `Cert:` `WSMan:` `Temp:`）、`名字::路径` | — | 是 | null（`provider`）；`FileSystem::C:\x`（含 `Microsoft.PowerShell.Core\FileSystem::`）去掉前缀后照常 |
| xargs 的输入、`find -exec` 的 `{}`、PowerShell 从管道绑定的目标 | 是 | 是 | null（`input`），text 为 `(paths from input)` |
| 看不出来的参数 | — | 是 | null（`parameter`），text 为 `(unrecognized parameters of <cmdlet>)` |

看得出来的路径用 `path.win32.resolve` 规范化（去掉 `.`、`..`、多余的分隔符）。commandScan 不判断它在不在工作路径里，也不判断受保护路径（§6）。

### 7.7 换目录与只读命令

**当前目录**：开始时是工作路径。下面的写法改变它；只在工作路径里换来换去时，只影响之后的目标怎样解析（proposal §5.1；这时报告的 leave 由 §6.4 丢掉）。

| 写法 | 新的当前目录 |
| --- | --- |
| bash `cd 目录`、`pushd 目录`（`-L` `-P` `-e` `-@` `--` 跳过） | 按 §7.6 解析；看不出来时为“看不出来”；命令里设过 CDPATH 之后、操作数不以 `/`、`\`、`.`、`~`、盘符开头时也看不出来（§7.4 的 CDPATH 一条） |
| bash `cd`（没有参数，去 HOME）、`cd -`、`cd` 带两个以上操作数、`pushd`（没有参数）、`pushd +N` / `-N`、`popd +N` | 看不出来；cd 没有参数时 text 为 `~` |
| bash `popd` | 回到这条命令里上一次 `pushd` 前的目录；栈空时看不出来 |
| PowerShell `Set-Location`（`cd` `chdir` `sl`）、`Push-Location`（`pushd`）`-Path` / `-LiteralPath` / 位置 0 | 按 §7.6 解析；`-StackName` 带值、`-PassThru` 开关 |
| PowerShell `Set-Location` 没有参数（7 去 HOME，5.1 不动）、`cd -`、`cd +` | 看不出来 |
| PowerShell `Pop-Location`（`popd`） | 同 bash 的 `popd` |

- **作用范围**：bash 里子 shell 结束后恢复：`( … )`、`$(…)`、`` `…` ``、`<(…)`、`>(…)`、多于一节的管道里的每一节、以 `&` 放到后台的命令（本机实测 `cd .. | true`、`cd .. &` 都不改当前目录）、嵌套的 `bash -c`。
  `{ …; }`、`if`、`for` 等不隔开。PowerShell 不隔开（§7.3）。
- **git 的目录**（Claude 对 PowerShell 只查工作目录，Mori 两种 shell 都按下面查，偏严）：一次 `git` 调用的目录是当前目录再按 `-C`（可以几个，后一个相对前一个）换过的结果；`--git-dir`、`--work-tree`（`=` 或分开写）、
  这条命令前缀的 `GIT_DIR=`、`GIT_WORK_TREE=`，以及之前 export / `$env:GIT_DIR = …` 设过的值，各自按 §7.6 相对这个目录解析（同 git：先换 `-C`）。
  只影响这次 git 调用；同一条命令上的重定向仍按 shell 的当前目录解析（`git -C .. diff > d.patch` 写的是工作路径里的 `d.patch`）。
  找子命令时跳过 git 的全局选项：带值的 `-C` `-c` `--git-dir` `--work-tree` `--namespace` `--config-env`，不带值的 `-p` `-P` `--no-pager` `--bare` `--no-replace-objects` `--literal-pathspecs` 等。

**leave**：一条简单命令（不是 `cd` 这类换目录的命令本身，不是只有赋值，不是包装、嵌套 shell、eval 这类容器——容器里的命令各自算）要运行时，
如果它**不在只读名单里**，并且下面任一个目录不是工作路径本身（字面上换过，不论换到哪里）或看不出来，就记一条 `ScanLeave`：

- shell 的当前目录（没有 `-C` 的 git 也看它）——form 是最后一次改它的写法；
- git 带 `-C` 时，换过之后的目录（form `git -C`，这时不再看 shell 的当前目录）；
- git 的 `--git-dir`、`--work-tree`、`GIT_DIR`、`GIT_WORK_TREE`（各一条）。

commandScan 不判断这些目录在不在工作路径里：目录联接会让字面上在里面的目录落到外面，所以每一次换目录都报告，由 §6.4 按真实路径判断，仍在工作路径里的丢掉
（`cd src && make` 的 leave 被丢掉，`cd <指向外面的目录联接> && npm i` 的留下）。
`ScanLeave` 不是写入目标，§6 把留下的当作“写到外面”出卡（proposal §5.1：“后面的部分按写到外面问”）。这条照 Claude 对 worktree 会话的检查
（命令的工作目录到了主文件夹，或者用了 `git -C` / `--git-dir` / `GIT_DIR` / `GIT_WORK_TREE`，就拦下；https://code.claude.com/docs/en/worktrees#how-claude-code-enforces-isolation）。
worktree 会话里 `git -C <主文件夹> merge …` 就是这样出卡的（proposal §5.4 的图）。

**git 自己的写入不算**（proposal §4 受保护路径一行）：git 命令不是写法，它写进自己仓库的 `.git`——包括 worktree 共用的、在工作路径外的 common `.git`、
工作路径是仓库子目录时上级的 `.git`——都不出现在 `writes` 里。只有命令里明写的目标（`echo x > .git/hooks/pre-commit`、`rm -rf .git`）是写入，由 §6 按受保护路径处理。

**只读名单**（`READ_ONLY_COMMANDS`，`commandScan.ts`；只用于 leave，不影响 §7.5 的写法——只读命令上的重定向照样是写入）

| shell | 名单 |
| --- | --- |
| bash | `ls dir vdir cat tac head tail less more wc nl od hexdump strings grep egrep fgrep rg ag file stat du df pwd echo printf true false test [ : which type whereis hash basename dirname realpath readlink date printenv whoami id hostname uname cut tr column paste join comm diff cmp md5sum sha1sum sha256sum cksum jq seq sleep dirs export local declare readonly typeset set unset shift read wait return exit`；`find`（没有 `-delete -exec -execdir -ok -okdir -fprint -fprint0 -fprintf -fls` 时）；`sort`（没有 `-o`、`--output` 时）；`tree`（没有 `-o` 时）；`uniq`（最多一个操作数：`uniq in out` 写 `out`）；`env` 与 `command -v` / `-V` 只打印时。`xxd` 不在名单里（`xxd in out` 写 `out`） |
| PowerShell | `Get-ChildItem`（`ls dir gci`）`Get-Content`（`cat gc type`）`Get-Item`（`gi`）`Get-ItemProperty`（`gp`）`Get-Location`（`pwd gl`）`Test-Path` `Resolve-Path`（`rvpa`）`Split-Path` `Join-Path` `Select-String`（`sls`）`Measure-Object`（`measure`）`Get-FileHash` `Compare-Object`（`compare diff`）`Select-Object`（`select`）`Where-Object`（`where ?`）`ForEach-Object`（`foreach %`，它的脚本块另算）`Sort-Object`（`sort`）`Group-Object`（`group`）`Format-Table`（`ft`）`Format-List`（`fl`）`Format-Wide`（`fw`）`Out-String` `Out-Host` `Out-Null` `Write-Output`（`echo write`）`Write-Host` `Write-Error` `Write-Warning` `Write-Verbose` `Get-Command`（`gcm`）`Get-Help`（`help man`）`Get-Date` `Get-Process`（`gps ps`）`Get-Service`（`gsv`）`Get-Variable`（`gv`）`Get-Alias`（`gal`）`ConvertFrom-Json` `ConvertTo-Json` `Start-Sleep`（`sleep`）；外部程序 `where findstr rg whoami hostname` |
| git 子命令（两边一样） | `status log diff show rev-parse ls-files ls-tree cat-file blame grep describe shortlog merge-base name-rev rev-list for-each-ref show-ref version help`（带 `--output` 时不算）；`branch`（没有操作数，选项只有 `-a -r -v -vv -l --list --all --remotes --show-current`）；`remote`（没有参数或只有 `-v`）；`stash list`；`config`（有 `--get --get-all --list -l --show-origin` 之一）；没有子命令的 `git` |

### 7.8 解析失败

`ok: false` 时整条命令**按写到外面处理**（临时默认值）：Ask each time 下命令本来就要问，卡上标出分析不了；Full access 下多问一次；
没人能批的会话（增强会话，§6）直接拒绝。理由：Claude 的 worktree 隔离对“从文字看不出 git 用法的命令形状”同样拦下（上面的 Claude 文档）；
分析不了时放行，会让 `case` 里的 `rm -rf ..` 这类认得出的写法漏掉。代价：按工具名的 Allow for this session 不放行这些命令（§6，写到外面不按工具名放行）。
§7.13 的语料统计量出这类命令有多少，再决定要不要改。
§6.4 把它记作理由 `unanalyzed`：卡上一行 `Couldn’t analyze this command: <reason>`；没人能批时拒绝原文的 `<why>` 是 `can't be analyzed: <reason>`（§6.15）；没有按目录放行（§6.9）；
有 `write_paths` 的收窄同样当作看不出写到哪里而拒绝（§8.4）。

| 原因（`reason`，英文，接在 “Couldn’t analyze this command: ” 后面） | 什么时候 |
| --- | --- |
| `unclosed quote` | 单引号、双引号、`$'`、PowerShell 的 here-string 没有闭合 |
| `unclosed bracket` | `(`、`{`（PowerShell）、`${`、`@(`、`@{` 没有闭合 |
| `unclosed command substitution` | `$(`、`` ` `` 没有闭合 |
| `the command name comes from a variable or substitution` | §7.4 |
| `the command text comes from a variable or input` | `eval`、`trap`、`bash -c`、`iex`、`-Command` 的文字有看不出来的部分；shell 从管道读命令 |
| `encoded command` | `-EncodedCommand` |
| `unsupported option <选项>` | `env -C`、`env -S`、PowerShell 的 `-WorkingDirectory` 与不认识的选项 |
| `PowerShell has no < redirection` | PowerShell 里的 `<`（整段脚本不会运行） |
| `stop-parsing token` | PowerShell 的 `--%`（§7.3） |
| `cmd.exe metacharacter in an argument` | PowerShell 里外部程序的参数去掉引号后不含空白、且含 `>` `<` `\|` `&`（§7.4） |
| `nested too deeply` | 括号、替换、嵌套 shell、eval 合计嵌套超过 32 层 |
| `the command is too long` | 命令文字超过 1,000,000 个字符（嵌套的文字是它的一部分，不另算） |

后台进程对每次解析失败记一行 `[kernel] command not analyzed (<shell>): <reason>`，不写命令原文。

### 7.9 单元测试表

`tests/unit/filesystem/scan-bash.test.mjs`、`scan-powershell.test.mjs` 逐行跑下面两张表，测试名以所属的验收编号和行号开头（例如 `FS-42 B12 …`，验收条目见 §19）；
一行属于两个条目时（B34、B42a–B42c、B76–B78、B80–B85、B106、B108、B114、S24a、S47、S50、S58–S60），用同一份期望各跑一次，名字分别以两个编号开头
（例如 `FS-47 B76 …`、`FS-49 B76 …`：覆盖检查只认名字开头的那一个编号）。
记号：工作路径 P = `C:\w\proj`；`vars` 的 TEMP、TMP、TMPDIR 都是 T = `C:\w\proj\.work\tmp`；W = `C:\w`。
`写 形式 路径`，删除加“删”，`into` 为真加“入”（没标的都是 false）；看不出来写 `?原因`；`离 形式 目录 命令`；`败 原因`；`无` 表示 `ok: true` 且两个列表都空。`⏎` 是换行，`⇥` 是 tab。
一行里用 `;` 或 `⏎` 连起来的是**同一条命令文字**，期望按出现顺序列出。

#### Git Bash（`shell: 'bash'`）

| 编号 | 命令 | 期望 |
| --- | --- | --- |
| B1 | `npm run build` | 无 |
| B2 | `npm run build > out.log` | 写 `>` P\out.log |
| B3 | `npm run build > ../out.log` | 写 `>` W\out.log |
| B4 | `echo hi >> notes/a.md` | 写 `>>` P\notes\a.md |
| B5 | `make 2> err.txt; make 2>>err2.txt` | 写 `2>` P\err.txt；写 `2>>` P\err2.txt |
| B6 | `make &> all.log; make &>> all2.log` | 写 `&>` P\all.log；写 `&>>` P\all2.log |
| B7 | `echo x >\| f; exec 3<> rw.bin; make >& b.log` | 写 `>\|` P\f；写 `3<>` P\rw.bin；写 `>&` P\b.log |
| B8 | `exec {fd}>named.log` | 写 `>` P\named.log |
| B9 | `cmd > /dev/null 2>&1; cmd 2>/dev/null; cmd &>/dev/null; cmd >&2; cmd 1>&2; exec 3>&-; cmd > /dev/stderr` | 无 |
| B10 | `sort < in.txt; cat <<< "x"` | 无 |
| B11 | `> out echo hi` | 写 `>` P\out |
| B12 | `ls \| tee list.txt` | 写 `tee` P\list.txt |
| B13 | `ls \| tee -a ../l.txt /dev/null` | 写 `tee` W\l.txt |
| B14 | `cp a.txt b.txt` | 写 `cp` P\b.txt |
| B15 | `cp -r src/ ../backup/; cp x ..; cp a b ../c` | 写 `cp` W\backup 入；写 `cp` W 入；写 `cp` W\c 入 |
| B16 | `cp -t dist a b; cp --target-directory=../d a; cp --target-directory ../e a` | 写 `cp` P\dist 入；写 `cp` W\d 入；写 `cp` W\e 入 |
| B17 | `cp -S .bak a b; cp --backup=numbered a c; cp only-one; cp --sparse always a d` | 写 `cp` P\b；写 `cp` P\c；写 `cp` P\d |
| B18 | `mv a.txt ../b.txt` | 写 `mv` P\a.txt 删；写 `mv` W\b.txt |
| B19 | `mv -t ../d x y` | 写 `mv` P\x 删；写 `mv` P\y 删；写 `mv` W\d 入 |
| B20 | `rm -rf build ../tmp.txt` | 写 `rm` P\build 删；写 `rm` W\tmp.txt 删 |
| B21 | `rm -- -weird.txt` | 写 `rm` P\-weird.txt 删 |
| B22 | `rm -rf .` | 写 `rm` P 删（§6：删掉工作路径本身） |
| B23 | `rmdir -p a/b` | 写 `rmdir` P\a\b 删 |
| B24 | `mkdir -p a/b c; mkdir -m 755 d; mkdir --mode=700 e` | 写 `mkdir` P\a\b；P\c；P\d；P\e |
| B25 | `touch -r ref.txt new.txt; touch -d '2026-01-01 10:00' f` | 写 `touch` P\new.txt；写 `touch` P\f |
| B26 | `ln -s ../target link` | 写 `ln` P\link |
| B27 | `ln -s /c/x/target` | 写 `ln` P\target |
| B28 | `ln -t ../bin tool` | 写 `ln` W\bin 入 |
| B29 | `sed -i 's/a/b/' src/x.ts` | 写 `sed -i` P\src\x.ts |
| B30 | `sed -i.bak -e 's/a/b/' -e 's/c/d/' f1 ../f2` | 写 `sed -i` P\f1；写 `sed -i` W\f2 |
| B31 | `sed --in-place=.orig -f script.sed f` | 写 `sed -i` P\f |
| B32 | `sed -ni 's/x/y/p' f; sed -in 's/x/y/' g` | 写 `sed -i` P\f；写 `sed -i` P\g |
| B33 | `sed 's/a/b/' f > g; sed -n '1p' f` | 写 `>` P\g |
| B34 | `echo x > "my dir/a b.txt"; echo x > 'a'"b"c; echo x > a\ b` | 写 `>` P\my dir\a b.txt；写 `>` P\abc；写 `>` P\a b |
| B35 | `cp a C:/other/b; cp a /d/x; cp a "D:\y"; cp a /cygdrive/e/z` | 写 `cp` C:\other\b；D:\x；D:\y；E:\z |
| B36 | `cp a C:\x` | 写 `cp` ?drive-relative |
| B37 | `echo > /tmp/x.log; cp a /usr/local/bin/` | 写 `>` ?shell-path；写 `cp` ?shell-path |
| B38 | `cp a //server/share/x` | 写 `cp` `\\server\share\x` |
| B39 | `echo > ~/x; echo > ~; echo > a~b` | 写 `>` ?home；写 `>` ?home；写 `>` P\a~b |
| B40 | `echo > $OUT; echo > "$HOME/x"; echo > ${1}.txt; echo > ${X:-y}` | 写 `>` ?variable（四条） |
| B41 | `echo > $TMPDIR/x.log; echo > "${TEMP}/y"; echo > $TMP` | 写 `>` T\x.log；写 `>` T\y；写 `>` T |
| B42 | `export TMPDIR=../t; echo > $TMPDIR/x` | 写 `>` ?variable |
| B42a | `TMPDIR=../t bash -c 'echo > $TMPDIR/x'` | 写 `>` ?variable |
| B42b | `env -i bash -c 'echo > $TMPDIR/x'; env -u TMPDIR bash -c 'echo > $TMPDIR/y'` | 写 `>` ?variable；写 `>` ?variable（两条，text 不同不去重） |
| B42c | `export TMPDIR=../t; bash -c 'echo > $TMPDIR/x'` | 写 `>` ?variable |
| B43 | `echo > $PWD/x; cd src && echo > "$PWD/y"` | 写 `>` P\x；写 `>` P\src\y |
| B44 | `rm *.log; cp a {b,c}; rm 'a*b'; touch x?` | 写 `rm` ?glob 删；写 `cp` ?glob；写 `rm` `P\a*b` 删；写 `touch` ?glob |
| B45 | ``echo > $(date +%s).log; echo > `pwd`/x; echo > $((1+1))`` | 写 `>` ?substitution（三条） |
| B46 | `npm i && echo ok > done.txt \|\| rm -f done.txt; touch t & wait` | 写 `>` P\done.txt；写 `rm` P\done.txt 删；写 `touch` P\t |
| B47 | `# rm -rf ..⏎echo a # > x` | 无 |
| B48 | `cp a \⏎  ../b` | 写 `cp` W\b |
| B49 | `touch a\r⏎touch b\r⏎`（CRLF） | 写 `touch` P\a；写 `touch` P\b |
| B50 | `if [ -f a ]; then rm a; fi > log` | 写 `rm` P\a 删；写 `>` P\log |
| B51 | `for f in *.txt; do cp "$f" ../bk/; done` | 写 `cp` W\bk 入 |
| B52 | `while read l; do echo "$l" >> out; done < in` | 写 `>>` P\out |
| B53 | `case $x in a) touch a;; (b\|c) rm b;; esac` | 写 `touch` P\a；写 `rm` P\b 删 |
| B54 | `[[ a > b ]] && touch c; (( n > 3 )) && touch d` | 写 `touch` P\c；写 `touch` P\d |
| B55 | `[ a > b ]` | 写 `>` P\b |
| B56 | `f() { rm -rf ../x; }; f; function g { touch y; }` | 写 `rm` W\x 删；写 `touch` P\y |
| B57 | `diff <(ls a) <(ls b); tee >(gzip > ../l.gz) < in` | 写 `>` W\l.gz |
| B58 | `cat > notes.md <<'EOF'⏎rm -rf ../x > y⏎EOF` | 写 `>` P\notes.md |
| B59 | `cat > f <<EOF⏎$(rm ../x)⏎EOF` | 写 `>` P\f；写 `rm` W\x 删 |
| B60 | `cat <<-EOF > a⏎⇥x⏎⇥EOF⏎touch b` | 写 `>` P\a；写 `touch` P\b |
| B61 | `cat > f <<EOF⏎no end line` | 写 `>` P\f |
| B62 | `FOO=1 BAR=$(pwd) rm x` | 写 `rm` P\x 删 |
| B63 | `env -u X LANG=C rm x⏎nohup rm -rf ../x &⏎time mkdir d⏎command rm y⏎nice -n 5 touch z⏎timeout -s KILL 10 touch w` | 写 `rm` P\x 删；写 `rm` W\x 删；写 `mkdir` P\d；写 `rm` P\y 删；写 `touch` P\z；写 `touch` P\w |
| B64 | `exec > ../run.log` | 写 `>` W\run.log |
| B65 | `find . -name '*.tmp' \| xargs rm -f` | 写 `rm` ?input 删 |
| B66 | `ls \| xargs cp ../x; ls \| xargs -I{} cp {} ../bk/; ls \| xargs cp -t ../bk2` | 写 `cp` ?input；写 `cp` W\bk 入；写 `cp` W\bk2 入 |
| B67 | `find . -name '*.o' -exec rm {} +; find src -type f -exec cp {} ../bk \;` | 写 `rm` ?input 删；写 `cp` W\bk |
| B68 | `find . -name '*.o' -delete; find . -newer x` | 无 |
| B69 | `bash -c 'echo x > ../o.txt'; sh -c "touch y"; bash -lc "rm z"; /usr/bin/bash -ec 'mkdir q'` | 写 `>` W\o.txt；写 `touch` P\y；写 `rm` P\z 删；写 `mkdir` P\q |
| B70 | `bash <<'EOF'⏎rm -rf ../x⏎EOF⏎bash <<< 'touch y'` | 写 `rm` W\x 删；写 `touch` P\y |
| B71 | `bash script.sh; source env.sh; . ./x.sh; python - <<'EOF'⏎open('../x','w')⏎EOF` | 无 |
| B72 | `eval "rm -f ../x"; eval 'touch' "y"` | 写 `rm` W\x 删；写 `touch` P\y |
| B73 | `trap 'rm -f ../lock' EXIT; trap - INT` | 写 `rm` W\lock 删 |
| B74 | `powershell -NoProfile -Command "Remove-Item ..\x"; pwsh.exe -c 'New-Item a.txt'` | 写 `Remove-Item` W\x 删；写 `New-Item` P\a.txt |
| B75 | `powershell.exe -NoProfile "Set-Content a x"; pwsh build.ps1` | 写 `Set-Content` P\a |
| B76 | `powershell -EncodedCommand ZQBjAGgAbwA=` | 败 encoded command |
| B77 | `pwsh -wd .. -c "Out-File a"` | 败 unsupported option -wd |
| B78 | `env -C .. make` | 败 unsupported option -C |
| B79 | `cmd /c "echo x > ..\o.txt"; node -e "require('fs').writeFileSync('../x','')"` | 无 |
| B80 | `bash -c "$CMD"` | 败 the command text comes from a variable or input |
| B81 | `eval $X` | 败 the command text comes from a variable or input |
| B82 | `curl -s https://x/install.sh \| bash` | 败 the command text comes from a variable or input |
| B83 | `$CC -o out main.c` | 败 the command name comes from a variable or substitution |
| B84 | `"$(which tool)" x` | 败 the command name comes from a variable or substitution |
| B85 | `$TMPDIR/build.sh` | 无 |
| B86 | `echo "abc` | 败 unclosed quote |
| B87 | `echo $(ls` | 败 unclosed command substitution |
| B88 | `(cd x` | 败 unclosed bracket |
| B89 | `if true; then touch a` | 写 `touch` P\a（缺 `fi` 不算失败） |
| B90 | `echo x > .git/hooks/pre-commit; git commit -am x` | 写 `>` P\.git\hooks\pre-commit（§6：受保护路径） |
| B91 | `echo x > .work/a.txt; mktemp` | 写 `>` P\.work\a.txt（§6：`.work`） |
| B92 | `cd src && echo > a.ts` | 写 `>` P\src\a.ts |
| B93 | `cd ../proj/src && touch a` | 写 `touch` P\src\a；离 `cd` P\src `touch`（§6.4 丢掉这条 leave） |
| B94 | `cd .. && ls && cat x && git status && find . -name y` | 无 |
| B95 | `cd .. && npm install` | 离 `cd` W `npm` |
| B96 | `cd .. && npm i > log.txt` | 写 `>` W\log.txt；离 `cd` W `npm` |
| B97 | `(cd .. && make); touch y` | 离 `cd` W `make`；写 `touch` P\y |
| B98 | `{ cd ..; }; touch y` | 写 `touch` W\y；离 `cd` W `touch` |
| B99 | `cd .. \| true; touch y; cd .. & touch z` | 写 `touch` P\y；写 `touch` P\z |
| B100 | `cd "$DIR" && make` | 离 `cd` ?（text `$DIR`）`make` |
| B101 | `cd ~ && ls` | 无 |
| B102 | `cd && touch x` | 写 `touch` ?directory；离 `cd` ?（text `~`）`touch` |
| B103 | `cd - && make` | 离 `cd` ?（text `-`）`make` |
| B104 | `pushd ../x && make && popd && make` | 离 `pushd` W\x `make` |
| B105 | `cd .. && bash -c 'rm -f a'` | 写 `rm` W\a 删；离 `cd` W `rm` |
| B105a | `export CDPATH=..; cd src && touch x; CDPATH=.. cd lib && make` | 写 `touch` ?directory；离 `cd` ?（text `src`）`touch`；离 `cd` ?（text `lib`）`make` |
| B105b | `CDPATH=.. cd ./src && touch x` | 写 `touch` P\src\x（以 `.` 开头不查 CDPATH）；离 `cd` P\src `touch`（§6.4 丢掉） |
| B106 | `git -C .. status; git -C .. log --oneline; git -C sub commit -m x` | 离 `git -C` P\sub `git commit`（§6.4 丢掉） |
| B107 | `git -C .. commit -m x` | 离 `git -C` W `git commit` |
| B108 | `git -C .. diff > d.patch` | 写 `>` P\d.patch |
| B109 | `git -C .. diff --output=x` | 离 `git -C` W `git diff` |
| B110 | `git --git-dir=../o/.git --work-tree=../o checkout main` | 离 `--git-dir` W\o\.git `git checkout`；离 `--work-tree` W\o `git checkout` |
| B111 | `GIT_DIR=../o/.git git log; GIT_DIR=../o/.git git reset --hard` | 离 `GIT_DIR` W\o\.git `git reset` |
| B112 | `export GIT_WORK_TREE=..; git add -A; unset GIT_WORK_TREE; git add -A` | 离 `GIT_WORK_TREE` W `git add`（一条） |
| B113 | `git -c core.x=1 -C .. merge mori/a; git -C .. branch; git -C .. branch new` | 离 `git -C` W `git merge`；离 `git -C` W `git branch` |
| B114 | 工作路径为 `C:\r\.mori\worktrees\a`（worktree 会话）：`git commit -am x; git -C ../../.. merge mori/a` | 离 `git -C` C:\r `git merge`（第一条无） |
| B115 | 一条超过 1,000,000 字符的命令 | 败 the command is too long |
| B116 | 33 层嵌套的 `$( … )` | 败 nested too deeply |
| B117 | `touch a; touch a` | 写 `touch` P\a（去重后一条） |
| B118 | `RM -rf ../x; Cp a ../b; /usr/bin/RM.EXE y` | 写 `rm` W\x 删；写 `cp` W\b；写 `rm` P\y 删 |

#### PowerShell（`shell: 'powershell'`）

| 编号 | 命令 | 期望 |
| --- | --- | --- |
| S1 | `npm run build` | 无 |
| S2 | `npm run build > ..\out.log` | 写 `>` W\out.log |
| S3 | `make 2> err.txt; make *> all.log; make 3>> w.log` | 写 `2>` P\err.txt；写 `*>` P\all.log；写 `3>>` P\w.log |
| S4 | `make 2>&1; make *>&1 > $null; make > $null` | 无 |
| S5 | `Set-Content -Path a.txt -Value x; Set-Content b.txt x; sc c.txt x` | 写 `Set-Content` P\a.txt；P\b.txt；P\c.txt |
| S6 | `Set-Content -LiteralPath '..\[x].txt' x; Set-Content -Path '..\[y].txt' x` | 写 `Set-Content` `W\[x].txt`；写 `Set-Content` ?glob |
| S7 | `Add-Content notes.md 'line'; ac -Value y -Path ..\n.md` | 写 `Add-Content` P\notes.md；写 `Add-Content` W\n.md |
| S8 | `'x' \| Out-File ..\o.txt -Encoding utf8; Out-File -FilePath:a.txt; Out-File -Path b.txt; Out-File -LP c.txt -Append` | 写 `Out-File` W\o.txt；P\a.txt；P\b.txt；P\c.txt |
| S9 | `Get-Process \| Tee-Object -FilePath p.txt; ls \| tee q.txt; ls \| Tee-Object -Variable v` | 写 `Tee-Object` P\p.txt；写 `Tee-Object` P\q.txt |
| S10 | `New-Item -ItemType Directory -Path build; ni x.txt; mkdir a\b; md ..\c` | 写 `New-Item` P\build；P\x.txt；P\a\b；W\c |
| S11 | `New-Item -Path src -Name a.ts; New-Item -Name b.ts -ItemType File` | 写 `New-Item` P\src\a.ts；写 `New-Item` P\b.ts |
| S12 | `New-Item -ItemType SymbolicLink -Path link -Target ..\x` | 写 `New-Item` P\link |
| S13 | `Copy-Item a.txt ..\b.txt; cp a b; copy a c; cpi -Path a -Destination dist; Copy-Item a; Copy-Item a ..\bk\` | 写 `Copy-Item` W\b.txt；P\b；P\c；P\dist；P 入（text `.`）；W\bk 入 |
| S14 | `Move-Item a ..\b; mv x y; mi z` | 写 `Move-Item` P\a 删；W\b；P\x 删；P\y；P\z 删；P 入（text `.`） |
| S15 | `Remove-Item -Recurse -Force dist; rm a; del b; erase c; rd d; ri e; rmdir f` | 写 `Remove-Item` P\dist、P\a、P\b、P\c、P\d、P\e、P\f，都删 |
| S16 | `Remove-Item a, b,..\c` | 写 `Remove-Item` P\a 删；P\b 删；W\c 删 |
| S17 | `Rename-Item a.txt b.txt; ren src\x.ts y.ts` | 写 `Rename-Item` P\a.txt 删；P\b.txt；P\src\x.ts 删；P\src\y.ts |
| S18 | `Copy-Item a -Dest ..\b; Remove-Item -Rec -Fo x` | 写 `Copy-Item` W\b；写 `Remove-Item` P\x 删 |
| S19 | `Set-Content -P a x` | 写 `Set-Content` ?parameter |
| S20 | `rm -rf build; Copy-Item a -Frobnicate x -Destination b; Remove-Item a b; Copy-Item @p` | 写 `Remove-Item` ?parameter 删；写 `Copy-Item` ?parameter；写 `Remove-Item` ?parameter 删；写 `Copy-Item` ?parameter |
| S21 | `Get-ChildItem *.tmp \| Remove-Item; ls *.log \| % { Remove-Item $_ }; dir \| Copy-Item -Destination ..\bk` | 写 `Remove-Item` ?input 删；写 `Remove-Item` ?variable 删；写 `Copy-Item` W\bk |
| S22 | `Out-File $out; Out-File "$env:TEMP\x.txt"; Out-File $env:tmp\y; Out-File "${env:TMPDIR}\z"` | 写 `Out-File` ?variable；T\x.txt；T\y；T\z |
| S23 | `Out-File "$HOME\x"; Out-File ~\x; Out-File "$PWD\x"; Out-File $pwd\y` | 写 `Out-File` ?variable；?home；P\x；P\y |
| S24 | `$env:TEMP = 'D:\t'; Out-File $env:TEMP\x` | 写 `Out-File` ?variable |
| S24a | `$env:TEMP = 'D:\t'; pwsh -c 'Out-File $env:TEMP\x'` | 写 `Out-File` ?variable |
| S25 | `Out-File "$(Get-Date -f yyyy).log"; Out-File (Join-Path $PWD x)` | 写 `Out-File` ?substitution（两条） |
| S26 | `Remove-Item Env:\FOO; New-Item HKCU:\Software\X; Set-Content Temp:\x y; Remove-Item FileSystem::C:\w\x` | 写 `Remove-Item` ?provider 删；写 `New-Item` ?provider；写 `Set-Content` ?provider；写 `Remove-Item` W\x 删 |
| S27 | `Out-File C:x.txt; Out-File \x.txt; Out-File /y.txt; Out-File \\srv\s\z` | 写 `Out-File` ?drive-relative；C:\x.txt；C:\y.txt；`\\srv\s\z` |
| S28 | `Set-Location ..; npm i` | 离 `Set-Location` W `npm` |
| S29 | `cd ..; Get-ChildItem; git status; Select-String x *.ts` | 无 |
| S30 | `sl src; Out-File a; cd ..\..; Out-File b` | 写 `Out-File` P\src\a；写 `Out-File` W\b；离 `Set-Location` P\src `Out-File`（§6.4 丢掉）；离 `Set-Location` W `Out-File` |
| S31 | `Push-Location ..\x; make; Pop-Location; make; pushd ..; popd; make` | 离 `Push-Location` W\x `make` |
| S32 | `cd -; npm i` | 离 `Set-Location` ?（text `-`）`npm` |
| S33 | `Set-Location; npm i` | 离 `Set-Location` ?（text `~`）`npm` |
| S34 | `( cd .. ); npm i; & { cd .\proj }; npm i` | 离 `Set-Location` W `npm`（第二个 npm 回到 P 里，无） |
| S35 | `git -C .. merge mori/x; git -C .. log` | 离 `git -C` W `git merge` |
| S36 | `$env:GIT_DIR = '..\o\.git'; git commit -m x` | 离 `GIT_DIR` W\o\.git `git commit` |
| S37 | `if (Test-Path a) { Remove-Item a } elseif ($b) { ni c } else { rm d }` | 写 `Remove-Item` P\a 删；写 `New-Item` P\c；写 `Remove-Item` P\d 删 |
| S38 | `foreach ($f in $files) { Copy-Item $f ..\bk }; $r = Copy-Item a b -PassThru; try { Remove-Item x } catch { } finally { ni y }` | 写 `Copy-Item` W\bk；写 `Copy-Item` P\b；写 `Remove-Item` P\x 删；写 `New-Item` P\y |
| S39 | `& { Remove-Item ..\x }; Invoke-Command -ScriptBlock { ni y }; $h = @{ a = (ni z) }` | 写 `Remove-Item` W\x 删；写 `New-Item` P\y；写 `New-Item` P\z |
| S40 | `if ($a > 5) { }; if ($a -gt 5) { }` | 写 `>` P\5 |
| S41 | `switch ($x) { 'a' { ni a } default { rm b } }` | 写 `New-Item` P\a；写 `Remove-Item` P\b 删 |
| S42 | `@'⏎Remove-Item ..\x⏎'@ \| Set-Content s.txt` | 写 `Set-Content` P\s.txt |
| S43 | `@"⏎$(Remove-Item ..\x)⏎"@ \| Out-File f` | 写 `Remove-Item` W\x 删；写 `Out-File` P\f |
| S44 | `# Remove-Item ..\x⏎<# rm ..\y #> Get-ChildItem` | 无 |
| S45 | ``Copy-Item a `⏎ -Destination ..\b; Out-File a` b.txt`` | 写 `Copy-Item` W\b；写 `Out-File` P\a b.txt |
| S46 | `Out-File 'it''s.txt'; Out-File "a b.txt"; Out-File ‘c.txt’` | 写 `Out-File` P\it's.txt；P\a b.txt；P\c.txt |
| S47 | `& $exe build` | 败 the command name comes from a variable or substitution |
| S48 | `& 'C:\tools\x.exe' build; & git -C .. merge b; .\build.ps1; . .\env.ps1` | 离 `git -C` W `git merge` |
| S49 | `iex 'Remove-Item ..\x'; Invoke-Expression -Command "ni y"` | 写 `Remove-Item` W\x 删；写 `New-Item` P\y |
| S50 | `Invoke-Expression $s` | 败 the command text comes from a variable or input |
| S51 | `bash -c 'rm -rf ../x'; pwsh -c "Out-File ..\y"` | 写 `rm` W\x 删；写 `Out-File` W\y |
| S52 | `Out-File "abc` | 败 unclosed quote |
| S53 | `Get-Content < in.txt` | 败 PowerShell has no < redirection |
| S54 | `ls \| % { ni a` | 败 unclosed bracket |
| S55 | `Out-File .work\notes.md; New-TemporaryFile; [IO.File]::WriteAllText('..\x', 'y'); Invoke-WebRequest u -OutFile ..\z` | 写 `Out-File` P\.work\notes.md |
| S56 | `Microsoft.PowerShell.Management\Remove-Item ..\x; Remove-Item a -WhatIf` | 写 `Remove-Item` W\x 删；写 `Remove-Item` P\a 删 |
| S57 | `cmd /c "del ..\x"; sed -i 's/a/b/' f; touch g` | 无 |
| S58 | `npm run build --% > ..\x` | 败 stop-parsing token |
| S59 | `npm run build '>' ..\x; npm run build '2>..\e'; .\t.cmd 'a\|b'` | 败 cmd.exe metacharacter in an argument |
| S60 | `git log --format='%h\|%s'` | 败 cmd.exe metacharacter in an argument（偏严，§7.13 语料统计后再定；`where.exe cmd '>' x` 原生不写文件，同样算失败） |

### 7.10 `.work` 的建立

**什么时候**：路径闸（§6.1 的判断顺序）**放行**下面两种调用、把结果交还 pi 之前，`await ensureWork(ctx.cwd)`：

1. `bash`、`powershell` 的调用——不论分析出写到哪里，因为每条命令的 TEMP 都指到 `.work/tmp`（§7.11）；
2. `write`、`edit` 的目标在 `.work` 里（§6.4 归为 `work`）。pi 的 write 自己会 `mkdir -p`，所以 `.gitignore` 必须在这之前写好。

另外两处由 §11 调用：建 worktree 时在新的工作路径里（proposal §5.4 的图：“写 .work/.gitignore 和 core.longpaths”），Initialize git 做第一次提交之前（这样 `.work/` 不进那次提交）。

被拒绝、被收窄挡下（§8）、等卡后被拒的调用不建；打开会话、只读取时不建，文件夹里就不会平白多出 `.work`。不在会话建立时建，不监视，
也不缓存“已经建过”：每次放行都检查一遍（三四个 `mkdir` / `stat` / `open` 系统调用），你或命令删掉 `.work` 之后，下一次调用会重建。

**`ensureWork(cwd)`**（`kernel/workspace.ts`）：

1. 工作路径本身不在（第 2 步的 `mkdir` 报 `ENOENT`）：什么都不建，返回成功；pi 照常报 `Working directory does not exist`（`bash.js:56-61`）。
   所以这里都不用递归的 `mkdir`，不会把被删掉的 worktree 重新建出来。
2. `mkdir(<cwd>\.work)`；已经有了时 `stat`，不是文件夹（链接到文件夹的算文件夹）→ 失败：`.work is a file, not a folder`。
3. `writeFile(<cwd>\.work\.gitignore, '*\n', { flag: 'wx' })`；已经有了（`EEXIST`）就不动——你自己改过的 `.gitignore` 不覆盖。
4. `mkdir(<cwd>\.work\tmp)`；已经有了时 `stat`，不是文件夹 → 失败：`.work/tmp is a file, not a folder`。
5. 其他错误（只读文件夹、没有权限）→ 失败，原因是 Node 的错误原文。

失败时路径闸不放行这次调用（临时默认值，§17），返回 `{ block: true, reason }`，原文见 §14；后台进程记 `[kernel] couldn't prepare .work in <cwd>: <原因>`。
原文的开头在 `DENIAL_PREFIXES` 里（§6.15、§12），工具卡显示 `Denied · Mori couldn’t prepare .work…`，预告时标上的放行标签按 §6.15 的实时规则去掉。

**`.gitignore` 的效果**：`*` 也忽略 `.gitignore` 自己，所以整个 `.work/` 不出现在 `git status`、`git status -uall`、`git add -A`、`git clean -nd` 里（本机 git 2.55 实测）。
快照另按 §4 总是排除 `.work/`，不靠这个文件。不是 git 仓库的文件夹也写它（以后 Initialize git 时就已经在了）。

**其他**：

- 每个工作路径一个 `.work`：worktree 会话的工作路径是它的 worktree，§11 建 worktree 时调 `ensureWork` 建它自己的（`.work/.gitignore` 没有提交，不会随 worktree 检出）。
- 同一工作路径上的几个会话、一个会话的后台实例共用一个 `.work` 和 `.work/tmp`；临时文件名由各程序自己取唯一的。
- Mori 不删 `.work` 里的东西（Agent 的草稿在里面），也不设大小上限；`.work/tmp` 这一轮同样不清理、不设上限（临时默认值，§17）。
  工作路径在 OneDrive 里时，命令的临时文件也会被同步。
- `.work` 是指向别处的链接时照样用；写进去算不算外面，按 §6 的路径解析。

### 7.11 TEMP、TMP、TMPDIR：bash 与 PowerShell 工具的 `spawnHook`

**接法**：`sessions.ts` 的 `createEntry`（`app/src/kernel/sessions.ts:426-428`）给 `createAgentSession` 加 `customTools: shellTools(pi, args.cwd, setup.settings)`。
用户会话、实例会话、增强会话都经过 `createEntry`，所以都一样。

```ts
/** @brief 每条命令的临时目录：<cwd>\.work\tmp。 */
export function workTmp(cwd: string): string;
/** @brief commandScan 认得的变量值（§7.2）：TEMP、TMP、TMPDIR → workTmp(cwd)。 */
export function workVars(cwd: string): Record<'TEMP' | 'TMP' | 'TMPDIR', string>;
/** @brief spawnHook：env 的副本里去掉 TEMP、TMP、TMPDIR 的各种大小写写法，再设成 workTmp(context.cwd)；
 *        同时去掉 CDPATH 的各种大小写写法（不设新值）；command、cwd 不变。 */
export function workEnv(context: BashSpawnContext): BashSpawnContext;
/** @brief 换掉 pi 内置的 bash、powershell：同样的定义加上 spawnHook，defaultActive 为 false。 */
export function shellTools(pi: Pi, cwd: string, settings: SettingsManager): ToolDefinition[];
```

`shellTools` 返回两个定义：

- `{ ...pi.createBashToolDefinition(cwd, { commandPrefix: settings.getShellCommandPrefix(), shellPath: settings.getShellPath(), spawnHook: workEnv }), defaultActive: false }`；
- `{ ...pi.createPowerShellToolDefinition(cwd, { spawnHook: workEnv }), defaultActive: false }`。

为什么这样写（都已在 pi 1.3.0 核实）：

| 事实 | 出处 | 做法 |
| --- | --- | --- |
| `customTools` 与内置工具同名时按名字换掉内置的，Map 里的位置不变，所以工具顺序、prompt 里的工具说明和准则都不变 | `dist/core/agent-session.js:2848-2869`、`:2893-2896` | 名字用 `bash`、`powershell` |
| 内置 bash 按设置的 `shellCommandPrefix`、`shellPath` 建，powershell 不带选项 | `agent-session.js:2934-2946`、`tools/index.js:89-99` | 照传，行为不变。`customTools` 在建会话时建一次；内置工具只在 `session.reload()` 时按新设置重建，Mori 不调用它（`app/src/kernel` 里没有 `session.reload`），所以两者一样 |
| `tool_call` 按调用里的工具名发给扩展，内置工具与 `customTools` 一样经过它 | `agent-session.js:322-347` | 路径闸照旧按名字 `bash`、`powershell` 认（§6.2） |
| 会话建立时 `includeAllExtensionTools: true`：`customTools` 里注册即启用的工具会被启用——不加 `defaultActive: false` 时，powershell 会在每个用户会话里被启用，你在 `defaultTools` 里去掉的 bash 也会回来 | `agent-session.js:210-213`、`:2908-2913`、`:2932`、`dist/core/extensions/types.d.ts:493-498` | `defaultActive: false`：启用与否只按名字（`defaultTools`，即 `sdk.js:148-160` 的 `initialActiveToolNames`；实例的白名单 `tools`，按名字启用不看 `defaultActive`，`agent-session.js:2899-2906`；`setActiveToolsByName`），与内置工具相同；白名单里没有的名字连注册都不注册（`agent-session.js:2854`） |
| 换掉后工具的 `sourceInfo` 是 `{ path: '<sdk:bash>', source: 'sdk' }`，不再是 `builtin:bash` | `agent-session.js:2850-2853` | 现在 `resources.ts` 的 `toolSource`（`app/src/kernel/resources.ts:228-239`）只认 `builtin:` 开头的路径，`<sdk:bash>` 会落到最后一行显示成扩展；改成也把 `source === 'sdk'` 当作内置（Mori 只用 `customTools` 换这两个工具），工具页仍显示 Built-in。`refreshTools`（`app/src/kernel/sessions.ts:591-597`）补扩展工具时按 `defaultActive !== false` 筛，不会在重新打开会话时启用它们；§8.6 另加的默认工具检查只看名字，不受替换影响 |
| `spawnHook` 是同步的，在 `execute` 里、放行之后调用 | `bash.js:135-157`、`:172-174` | `workEnv` 只改环境，不碰文件；建 `.work` 在路径闸里（§7.10） |
| Windows 上 env 名字不分大小写，子进程的 env 里同名不同写法时 Node 只用排序后第一个 | Node `child_process` 文档 | `workEnv` 先删掉 `Temp`、`tmp` 等写法（同 `pi.ts` 对 `PI_PACKAGE_DIR` 的做法，`app/src/kernel/pi.ts:22-26`） |

- **从不改 `process.env`**（proposal §3）：所有会话共用一个后台进程，改了会互相影响。pi 自己的截断输出仍写后台进程的 `os.tmpdir()`
  （`dist/utils/output-files.js:16`），这是 pi 自己的文件，不算 Agent 的写入（proposal §9 第 2 条），也正好说明 `process.env` 没被改。
- **为什么也设 TMPDIR**：Git Bash 的 `mktemp`、Python 的 `tempfile` 先看 TMPDIR；Windows 平常不设它。本机实测：设了之后 Git Bash 的 `mktemp`、
  PowerShell 的 `[IO.Path]::GetTempPath()` 与 `New-TemporaryFile`、Node 的 `os.tmpdir()`、Python 的 `tempfile.gettempdir()` 都落在 `.work\tmp`。
  Git Bash 里 `$TEMP`、`$TMP` 显示成 POSIX 写法（msys 启动时换过），指的是同一个目录；要 Windows 写法用 `cygpath -w "$TEMP"`。
- **Git Bash 的 `/tmp` 不跟着变**：本机实测从 Node 起 Git Bash、env 里 TEMP、TMP、TMPDIR 都指到 `.work\tmp` 时，`cygpath -w /tmp` 仍是 `C:\Users\<你>\AppData\Local\Temp`
  （`mount` 显示 `/tmp` 是 `usertemp`）。
  所以身份段告诉模型用 TEMP / TMPDIR 而不是 `/tmp`，commandScan 也把 `/tmp/…` 算看不出来（§7.6）。
- **去掉 CDPATH**：bash 的 `cd` / `pushd` 对不以 `/`、`.`、`..` 开头的操作数先查 CDPATH，继承你环境里的 CDPATH 会让 §7.7 按当前目录解析的结果与实际不符
  （`scanCommand` 不读环境变量，无从得知）。`workEnv` 去掉它的各种大小写写法，不设新值；命令自己设的 CDPATH 由 §7.4 处理。`workVars` 不变。
- 除 TEMP、TMP、TMPDIR（设值）与 CDPATH（去掉）外，HOME、PATH 等其他变量不改。

### 7.12 告诉模型

身份段（记忆规格附录 A.1，现在是 `app/src/kernel/memoryText.ts:18-28` 的 `IDENTITY_TEXT`，§6.16 改成 `identityText(permission)`）在批准那一句之后加一行（原文见 §14），
三种 `permission` 下这一行相同。它对所有会话与实例都一样：`limits.write` 为 false 的实例和增强会话写 `.work` 会被拒绝（§8、记忆规格 §9.6），拒绝原文自己说明，这一行不按身份变。
批准那一句按模式的改写在 §6；两处合成后的全文在 §14。改了模型看到的文字，按 AGENTS.md 要重录 fixture、用真实模型走一遍（FS-54）。

### 7.13 语料统计

proposal §14 写明“命令分析能覆盖多少真实命令”没有验证。真实层的一步（FS-55）用 `scanCommand` 跑一遍
`tests/fixtures/**` 与本机 Mori 的 pi 会话文件（`<agentDir>/sessions`）里全部 bash、powershell 调用，
记下：总数、认出写入的、有看不出来的目标的、有 leave 的、解析失败的（按 reason 分）、只在 Full access 下会多问的。
检查记录只写数字和命令的形状（例如 “`case … esac`”），不写命令原文。§7.5 的名单、只读名单和 §7.8 的默认按这次的结果再定。

## 8. 收窄、TaskBoard 与增强会话

proposal §4“收窄”、§5.5、§9 第 1 条、§12 第 4 条、§13 第 3、4、20 条。碰文件的工具（读取、写入、编辑、命令、MCP）对所有 Agent 都一样，
不再随角色、会话种类或协作模式开关；派 subagent 的 Agent 和程序只能**收窄**，越界的调用在路径闸的第 2 步（§6.1）直接拒绝、
不出卡。本节定 `limits` 的形状与校验、谁受什么收窄、`limits.ts` 的检查、收窄在运行时放在哪里、去掉哪些工具开关、写入锁、
已存的 `board.json`、模型看到的文字，以及增强会话。属于后台进程第 9 件事“工作区”的路径闸。

### 8.1 现在怎样（已核对代码）

| 现在的开关 | 位置 | 做法 |
| --- | --- | --- |
| 实例的工具白名单 | `app/src/kernel/roles.ts:557-562`（`toolAllowlist`）；`app/src/kernel/team.ts:1063`、`app/src/kernel/team.ts:1364` | task 实例且不是只读：角色的工具（`app/src/kernel/roles.ts:533-535`，没写 `tools` 时 = pi 设置的默认工具 + `mcp__*`）；只读 task、立项、结案、临时提问、订阅：读取类（`app/src/kernel/roles.ts:543-545`，角色工具 ∩ `read`/`grep`/`find`/`ls`，不含 MCP；默认设置下只有 `read`） |
| 对话会话每次运行启用的工具 | `app/src/kernel/team.ts:1412-1449`（`beforeUserRun` → `applyDialogTools`）；`app/src/kernel/roles.ts:574-584`（`dialogTools`） | 协作模式：对话持有者的读取类 + `board_read`、`read_session`、`agent_message`（合并会话加立项的六个与 `memory`）；关闭模式：写了 `tools` 的对话角色设成它的工具加 `memory`；否则按此刻启用的那一组（`memory` 由 pi 照常启用，`app/src/kernel/memoryTool.ts:395` `defaultActive: true`），回到关闭模式时先恢复 `mori.team.tools` 记下的那一组（`app/src/kernel/team.ts:94-113`、`259-262`、`1572-1588`）并加 `memory`；有别的角色时都加 `agent_message` |
| 运行中的拦截 | `app/src/kernel/team.ts:1516-1526`（`guardCall`）、`app/src/kernel/team.ts:64`（`RELAY_ONLY`） | 对话会话调用这次运行开始时算出的集合（`LaneRun.allowed`，`app/src/kernel/teamLanes.ts:102-103`、`app/src/kernel/teamRuns.ts:47-56`）之外的工具：协作模式拒绝为 `Task mode is on: the dialog agent only relays; the work is done in tasks.`，关闭模式为 `<tool> is not one of <role>'s tools.` |
| 角色文件的 `tools` | `app/src/kernel/roles.ts:23-24`（`PI_TOOL_NAMES`）、`39-40`（`MCP_TOOL_PATTERN`）、`210-215`（`toolProblems`）、`311`、`372`、`434`（基座的 `tools: null`）；`RoleDef.tools`（`app/src/kernel/roles.ts:87-88`） | pi 工具名与 `mcp__<服务>__<工具或 *>`；写了 TaskBoard 工具算错 |
| `task_create.read_only` | `app/src/kernel/boardTools.ts:150-158`（必填 boolean）、`236-237`、`282-283`；`app/src/kernel/teamTools.ts:458-465`；`app/src/kernel/board.ts:420-422`、`444`；`app/src/kernel/teamTypes.ts:168-169` | 存进 `BoardTask.readOnly`；建 task 的会话时抄到 `Lane.readOnly`（`app/src/kernel/team.ts:621-626`、`app/src/kernel/teamLanes.ts:122-123`）；`task_edit` 没有这个参数（`app/src/kernel/boardTools.ts:159-164`） |
| 临时提问只读 | `app/src/kernel/teamTools.ts:237-259`（`askRole`，`readOnly: true` 写死） | 靠读取类白名单；`agent_message` 没有权限参数（`app/src/kernel/boardTools.ts:128-135`） |
| 写入锁 | `app/src/kernel/boardRoute.ts:54-80`（第 69、75 行） | `!task.readOnly` 的 task 在第一个实例开始时取 `board.lock`；`app/src/kernel/board.ts:317-323` 在 task 结束时释放 |
| 增强会话 | `app/src/kernel/sessions.ts:478-486`（`userApproval`） | 一开始 `setMode('all')`；`mori-memory` 拒绝它和它全部实例的 `write`、`edit`（`app/src/kernel/memoryExtension.ts:31`、`193-201`） |

- 读取类白名单之所以成立，是因为 pi 对不在启用列表或白名单里的工具直接回 `Tool <name> not found`，不经过 `tool_call`（平行 Agent 规格 §14.6 T-T1、T-T2）。
  一旦命令给出去，白名单就拦不住写入（proposal §2 第 3 条），所以改成按调用判断。
- pi 打开已保存的用户会话时，按会话记录里最后一次的工具组合恢复启用的工具（`app/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:214-215`、`1374-1382`；
  只在不传 `tools` 白名单时，`dist/core/sdk.js:314`）。实例会话传白名单，按白名单建立，不恢复。

### 8.2 `limits`

**形状**（三处同一个意思）：

| 用在哪里 | 写法 |
| --- | --- |
| `task_create`、`agent_message` 的参数 | `limits?: { write?: boolean, commands?: boolean, mcp?: boolean, write_paths?: string[] }` |
| `board.json` 的 `BoardTask.limits`、后台进程的类型 `Limits`（`kernel/limits.ts`） | `{ write?: false, commands?: false, mcp?: false, writePaths?: string[] }`；`BoardTask.limits` 必填，没有限制时为 `{}`（§8.8） |

**每一项拒绝什么**（限制以内照常按 §6 的分类、权限模式和路径判断）：

| 项 | 拒绝 | 不拒绝 |
| --- | --- | --- |
| `write: false` | `edit`、`write`（含写 `.work`）；全部命令（`bash`、`powershell`，命令里只有 `ls`、`git status` 这类只读命令的也拒绝：命令也会写文件，proposal §4“收窄”） | 读取类工具（含 pi 的 `ls` 工具）、MCP 与扩展工具、职责工具 |
| `commands: false` | 全部命令 | 其余 |
| `mcp: false` | §6.2 分类为 `other` 的调用（MCP 工具，以及扩展注册的、不是职责工具的工具） | 其余 |
| `write_paths` | `edit`、`write` 的目标，和 §7 分析出的命令写入目标，按 §6.4 归类后不是 `work`、也不在任何一项里的；§6.4 记为看不出（`unresolved`）的目标、换目录到工作路径外之后还执行了非只读部分的命令（`leaves`）、分析不了的命令（`unanalyzed`）都算不在里面 | 归为 `work` 的写入（`.work/` 里）；认不出写入的命令（§7）；`write_paths` 里的受保护路径照常到第 3 步出卡 |

- 读取（`read`、`grep`、`find`、`ls`）和职责工具（TaskBoard 工具、`memory`、`ask_user_question`，§6 判断顺序第 1 步；2026-10-27 注：收尾检查落地后另有 `finish`，见 [finish-check.md](finish-check.md) §11）从不被收窄拒绝。
- 拒绝不出卡、不进无人应答的计时（§9），不受权限模式、“Allow for this session”、按目录放行影响：Full access 也不放行越界的调用。

**解析与校验**（`limits.ts` 的 `parseLimits(raw, cwd)`，`task_create` 与 `agent_message` 共用；参数先经 `prepareArguments`，再经 pi 按 schema 校验）：

1. `prepareArguments`：`limits` 里的键名与顶层一样归一（不分大小写、不看 `_` 与 `-`，`argOf`，`app/src/shared/team.ts:458-463`），schema 里没有的键丢掉（同平行 Agent 规格 §6.2 的规则）。
2. pi 的 schema 校验：`write`、`commands`、`mcp` 是 boolean；`write_paths` 是 1–10 个字符串（`minItems`、`maxItems`），不合格由 pi 报错（pi 自己的文字）。
3. `true` 与不写相同，不存。`write: false` 时去掉 `commands` 和 `write_paths`（已经包含在里面）。
4. `write_paths` 每一项：去掉首尾空白后按 win32 路径处理：
   - 以盘符、`\`、`/`、`~` 开头的拒绝：`limits.write_paths: "<p>" must be relative to the working directory.`
   - `path.resolve(cwd, p)` 不在工作路径里（`pathGate.ts` 的 `insideDir`，§6）：`limits.write_paths: "<p>" is outside the working directory.`
   - 就是工作路径本身（`.`、`src/..`）：`limits.write_paths: "<p>" is the whole working directory; leave write_paths out.`
   - 合格的写成相对工作路径、`/` 分隔、末尾带 `/` 的形式（`src\a` → `src/a/`）；去重；被另一项包含的去掉（有 `src/` 时去掉 `src/a/`）。
     不检查是否存在（task 可以新建这个目录）；一项可以是文件，它和它下面都算在里面。
5. 被拒绝时工具结果按平行 Agent 规格 §6.2 写两行：第一行上面的原因，第二行这个工具的 Correct form；TaskBoard 不变、不开实例。
   `agent_message` 在 `routeAgentMessage` 之前解析 `limits`，所以被拒绝的消息不计入条数上限（`agentMessage`，`app/src/kernel/teamTools.ts:168-187`：第 175 行路由、第 179 行计数）。
6. `task_edit` 没有 `limits`：task 的限制在建立时定下，之后不能改（同现在的 `read_only`）。

### 8.3 谁受什么收窄

| 会话 | 收窄 | 来源 | 拒绝原文的开头 |
| --- | --- | --- | --- |
| task 实例 | 这个 task 的 `limits`（没写就不限） | `task_create`，立项给的；这个 task 的所有实例（交回、换角色）都按它 | `Not allowed for this task` |
| 临时提问实例 | `{ write: false }`，发起方当时有 `mcp: false` 或 `agent_message.limits` 写了 `mcp: false` 时加上它 | 程序 + 发起方 + `agent_message.limits` | `Not allowed for this question` |
| 立项（分开时的实例） | `{ write: false }` | 程序（proposal §13 第 3 条） | `Not allowed while deciding requests` |
| 结案 | `{ write: false }` | 程序 | `Not allowed while closing a request` |
| 订阅 | `{ write: false }` | 程序 | `Not allowed in a subscription` |
| 对话会话，协作模式（分开时） | `{ write: false, mcp: false }` | 程序（proposal §13 第 4 条） | 整句 `Task mode is on: the dialog agent only relays; the work is done in tasks.` |
| 对话会话，协作模式（合并会话） | `{ write: false, mcp: false }` | 程序 | 同上 |
| 对话会话，关闭模式（主 Agent） | 不收窄 | — | — |

- **task 收窄的是用户会话的权限**：task 的限制只来自它自己的 `limits`。立项被程序收窄的 `{ write: false }` 不传给它建的 task；合并会话在协作模式下的
  `{ write: false, mcp: false }` 也不传下去（proposal §4“收窄”）。task 在限制以内仍按用户会话的权限模式与路径判断（§6）。
- **临时提问只能比发起方更窄**：`write` 总是 `false`（程序给，写不写都一样）。`write: false` 已经包含命令和 `write_paths`，所以发起方的限制里只剩
  `mcp: false` 需要继承；`agent_message.limits` 能再加的也只有 `mcp: false`。`askLimits(asker, given)` = `{ write: false }`，`asker.mcp === false || given.mcp === false`
  时再加 `mcp: false`。没有放宽的写法。发起方“当时的限制”是 `Team.narrowingFor(发起方)?.limits ?? NO_LIMITS`（§8.5）：task 实例为它的 task 的 `limits`；
  立项、结案、订阅为 `{ write: false }`；对话会话按这次运行的模式（上表，关闭模式下为 `NO_LIMITS`）。临时提问没有 `agent_message`（`app/src/kernel/roles.ts:61`），不会再开临时提问。
  例：协作模式下对话 Agent 发起的临时提问不能用 MCP；关闭模式下主 Agent 发起的只有 `{ write: false }`。
- **`agent_message.limits` 只在这条消息开出临时提问时用**（平行 Agent 规格 §10.1 第 3 条路由，以及关闭模式下的全部提问）；发到 task、进立项或结案会话时不用，
  照常投递（立项、结案本来就被程序收窄）。写了不合格的 `limits` 时不论去向都按 §8.2 第 5 步拒绝。
- **对话会话按运行开始时的模式**：用这次运行的 `LaneRun.mode`（`app/src/kernel/teamRuns.ts:46-49`：`agent_start` 时取 `before_agent_start` 定下的 `nextUserRun`，`app/src/kernel/team.ts:1412-1418`）；
  工具调用都在运行里，所以 `user.run` 总在；万一为空按 `Team.mode`。模式改变只影响之后的运行（平行 Agent 规格 §5.1，`agentMessage` 也这样取模式，`app/src/kernel/teamTools.ts:174`）。
  程序投递到用户会话开始的运行（`request_closed`、`relay`、`ask_user`、`create_wake`）同样按它开始时的模式。
- **合并会话为什么也是 `{ write: false, mcp: false }`**：合并会话里用户会话同时是对话 Agent 和立项 Agent，两个席位的收窄取并集（收窄只会更窄）；
  现在合并会话在协作模式下也只有读取类、没有 MCP（`app/src/kernel/roles.ts:582-583`，`INSTANCE_TEAM_TOOLS.create` 不含碰文件的工具），这样定与现在的效果相同；
  合并会话的立项段也写明 “in task mode you can't change files, run commands or use MCP tools yourself”（附录 A，改后的原文见 §14）。理由文字用同一句 `RELAY_ONLY`：这个会话就是对你说话的那一个。
- 角色文件有问题、只有基座的用户会话没有 Team（`app/src/kernel/sessions.ts:514`），不收窄（它也不能发送，平行 Agent 规格 §4.4）。

### 8.4 检查：`limits.ts`

`kernel/limits.ts`（新，纯函数，不载入 pi）：

| 导出 | 做什么 |
| --- | --- |
| `type Limits`、`NO_LIMITS`、`PROGRAM_LIMITS`（`{ write: false }`）、`TEAM_DIALOG_LIMITS`（`{ write: false, mcp: false }`） | §8.2、§8.3 |
| `interface Narrowing { owner: NarrowingOwner, limits: Limits }`（`NarrowingOwner = 'task' \| 'ask' \| 'create' \| 'close' \| 'subscription' \| 'dialog'` 定义在 `shared/workspace.ts`） | 谁的收窄（决定拒绝原文的开头） |
| `parseLimits(raw, cwd)` → `{ limits } \| { error }` | §8.2 的解析与校验 |
| `askLimits(asker, given)` | §8.3 |
| `limitsText(limits)` → `string \| null` | 工作卡与 `board_read` 里的写法（§8.9）；没有限制时为 `null` |
| `checkLimits(narrowing, call, cwd)` → `string \| null` | 越界时返回拒绝原文，否则 `null` |

拒绝原文的开头（§8.3 的表）与 `RELAY_ONLY`（从 `app/src/kernel/team.ts:64` 移过来，原文不变）放在 `shared/workspace.ts`（`NARROWING_LEADS: Record<Exclude<NarrowingOwner, 'dialog'>, string>`，五个开头；`dialog` 用整句 `RELAY_ONLY`），
`limits.ts` 从那里取；界面要靠它们认出程序拒绝（§6.15 的 `DENIAL_PREFIXES`，完整的一张在 §12），而界面不能 import `kernel/`。

`checkLimits` 的输入 `call` 是 §6.2–§6.4 的分类结果（`pathGate.ts` `classifyCall`：种类 `read` / `file` / `command` / `other`，每个写入目标的归类与真实路径，
`unresolved`、`leaves` 与 `unanalyzed`），是路径闸在第 2 步之前做好的那一次分类（§6.1）；`cwd` 是工作路径的真实路径（§6.3）。职责工具在路径闸第 1 步已经放行，到不了这里。
按下面的顺序，第一条命中的就是结果：

| 顺序 | 条件 | 规则文字 |
| --- | --- | --- |
| 1 | 种类 `read` | 不拒绝（`null`） |
| 2 | `write: false`，种类 `file` 或 `command`，或工具名是 `edit`、`write`（含 §6.2 因参数里没有字符串 `path` 归为 `other` 的） | `no file changes or commands` |
| 3 | `commands: false`，种类 `command` | `no commands` |
| 4 | `mcp: false`，种类 `other`（不含上一条的 `edit`、`write`） | `no MCP or extension tools` |
| 5 | 有 `writePaths`，种类 `file` 或 `command`（或没有 `path` 的 `edit`、`write`），有一个目标看不出（`unresolved`、没有 `path`），或命令有（§6.4 留下的）`leaves`，或分析不了（`unanalyzed`） | `writes are limited to <列表> and .work/, and Mori can’t tell where this writes` |
| 6 | 有 `writePaths`，有一个写入目标归类不是 `work`，并且它相对 `cwd` 的段不以任何一项的全部段开头（段名比较同 §6.3：不分大小写，去掉末尾的 `.` 与空格） | `writes are limited to <列表> and .work/; <目标> is outside them` |
| 7 | 其余 | `null` |

- 拒绝原文 = `<开头>: <规则文字>.`（开头见 §8.3 的表）；`owner` 为 `dialog` 时只用整句 `RELAY_ONLY`，不加规则文字。
  `<列表>` 是 `writePaths` 用 `, ` 连起来（`src/, docs/`）；`<目标>` 在工作路径里时写相对路径（`/` 分隔），在外面时写绝对路径。
  例：`Not allowed for this task: writes are limited to src/ and .work/; docs/a.md is outside them.`（proposal §5.5 的例子 “writes are limited to src/” 加上 `.work/` 与目标）。
- 第 2–4 条只看种类与工具名；第 5、6 条用写入目标，取自路径闸在第 2 步之前做的那一次分类（§6.1，一次判断只分类一次）。
- 返回 `{ block: true, reason }`，pi 把 `reason` 原样作为工具结果给模型（同现在的拒绝）；不带 `terminate`。`mori.tool_gate` 为 `deny`，工具卡显示 `Denied · <原文>`（§6.14、§6.15）。
- 一个调用有几个写入目标（复合命令）时逐个看，第一个越界的目标写进原文。
- 资源：纯函数，一次检查最多比 10 项 `writePaths` × 命令的写入目标（目标数的上限是 §6.3 的 100 个），不读文件、不缓存。

### 8.5 运行时：收窄放在哪里、怎样到路径闸

- **TaskBoard**：`BoardTask.limits`（§8.2，`teamTypes.ts` 的 `BoardTaskSchema` 用必填的 `LimitsSchema` 代替 `readOnly`，§8.8；`board.ts` 的 `CreateTaskInput.limits` 代替 `readOnly`）。
- **会话**：`Lane.limits: Limits` 代替 `Lane.readOnly`（`app/src/kernel/teamLanes.ts:122-123`、`172-180`）：
  - `taskLane`：取 `BoardTask.limits`（`app/src/kernel/team.ts:621-626`）；限制建立后不变，重新打开会话时从 `board.json` 重新取；
  - `createLane`（分开时）、`closeLane`、`startSubscription`（`app/src/kernel/team.ts:588-601`、`806-815`，都经 `laneFor`，`app/src/kernel/team.ts:629-636`）：`PROGRAM_LIMITS`；
  - `askRole`：`askLimits(team.narrowingFor(发起方)?.limits ?? NO_LIMITS, 解析出的 agent_message.limits)`（`app/src/kernel/teamTools.ts:237-259`）；
  - 用户会话（`app/src/kernel/team.ts:236-237` 的 `newLane`）：`NO_LIMITS`，不用；`Team.narrowingFor(user)` 按这次运行的模式给 `{ owner: 'dialog', limits: TEAM_DIALOG_LIMITS }` 或 `null`（§8.3）。
- **`Team.narrowingFor(lane)`** → `Narrowing | null`：用户会话见上；实例为 `{ owner: lane.kind, limits: lane.limits }`，`limits` 为空时 `null`。
- **到路径闸**：一个用户会话仍只有一份 `ApprovalPolicy`（模式、Allow for this session、按目录放行，§6），对话会话与全部实例共用；收窄是每个 `ApprovalGate` 自己的一层：
  - `GateOutput`（`app/src/kernel/approval.ts:50-63`）加 `narrowing?: () => Narrowing | null`：路径闸第 2 步每次调用时取（§6.1 的判断顺序；预告 `announce` 用同一个判断，所以也调它），省略时不收窄；
    另加 `kind: 'user' | InstanceKind`（同 `SessionSetup.kind`，§9.2 用它选到时原文的最后一句；`createEntry` 建 gate 时写 `{ ...setup.gate, kind: setup.kind, send }`，`startUser` 与 `instanceSetup` 都不用改）。
    不从 `narrowing()?.owner` 推断会话种类：`limits` 为空的 task 实例（最常见的）`narrowingFor` 返回 null；
  - 实例：`InstanceSpec` 加 `narrowing: Narrowing | null`（`app/src/kernel/team.ts:1052-1071` 的 `instanceSpec` 填 `narrowingFor(lane)`），`instanceSetup`（`app/src/kernel/instances.ts:62-72`）把它包成 `narrowing: () => spec.narrowing` 放进 `gate`；
  - 用户会话：`TeamLike`（`app/src/kernel/teamHost.ts:193-244`）加 `userNarrowing(): Narrowing | null`（= `narrowingFor(this.user)`）；`startUser`（`app/src/kernel/sessions.ts:510-513`）的 `gate` 写
    `{ prefix: '', narrowing: () => team?.userNarrowing() ?? null }`（同那里 `seats` 的写法，`team` 在后面赋值）；角色文件有问题、没有 Team 时为 `null`。
- 共用的 `ApprovalPolicy` 不知道收窄：切到 Full access、选 “Allow … for this session”、按目录放行时它放行的只是已经挂起的请求，而挂起的请求都已通过第 2 步；
  被收窄拒绝的调用从不挂起。`mori.tool_gate` 的预告与更正按 §6。

### 8.6 去掉按工具开关的做法

**实例的工具白名单**：`toolAllowlist` 改为 `instanceTools(kind, baseDefaults, team)` = pi 设置的默认工具（`TeamArgs.baseTools`，`app/src/kernel/sessions.ts:474`，没设时 `read`、`bash`、`edit`、`write`）
\+ `mcp__*` + 这个种类的 TaskBoard 工具（`INSTANCE_TEAM_TOOLS`，`app/src/kernel/roles.ts:57-63`，关闭模式的临时提问没有）；`instanceSpec` 照旧在后面接 `memoryTools(kind)`（`app/src/kernel/team.ts:1063`、`1078-1081`，不变）。
碰文件的部分所有种类一样，就是现在基座 task 实例的那一组（`app/src/kernel/roles.ts:533-535`）；用户会话里其他扩展注册的工具不进实例的白名单，同现在。
`app/src/kernel/team.ts:1063` 与 `laneHooks`（`app/src/kernel/team.ts:1364`，注册哪些 TaskBoard 工具）都用它。

**用户会话每次运行的工具**：`applyDialogTools` 改为 `applyDutyTools(mode)`，在 `beforeUserRun`（`app/src/kernel/team.ts:1412-1418`）里调用，**只动职责工具**：
启用的工具 = 此刻启用的工具去掉全部职责工具（`TEAM_TOOLS` 与 `memory`）+ 下表里这次运行的那几个中已注册的；有变化时才 `setActiveTools`。碰文件的工具一个都不动。

| 这次运行 | 启用的职责工具 |
| --- | --- |
| 关闭模式，没有别的角色 | `memory`（TaskBoard 工具一个都不启用；与 pi 此刻启用的相同，所以不调 `setActiveTools`；TB-03 比较时除 memory 外另去掉 `ask_user_question`，§19.4） |
| 关闭模式，有别的角色 | `agent_message`、`memory` |
| 协作模式，分开时 | `board_read`、`read_session`、`agent_message`（`memory` 不启用，记忆规格 §7.6 不变） |
| 协作模式，合并会话 | `board_read`、`read_session`、`agent_message`、立项的六个、`memory` |

- `ask_user_question` 在用户会话里一直启用（三种席位，§10.1），`applyDutyTools` 不动它，不在这张表里。
- （2026-10-27 注：收尾检查，见 [finish-check.md](finish-check.md) §11）`finish` 同 `ask_user_question`：用户会话里一直启用，`applyDutyTools` 不动它、不在这张表里；
  它进 `DUTY_TOOLS`，在路径闸里算 `duty`（§6.1 第 1 步、§6.2 的 `duty` 一行、§8.2 “职责工具从不被收窄”），协作模式下对话会话的 `mcp: false` 才不会把它当 `other` 拒绝。
  收尾检查若先落地，它在 `applyDialogTools` 与 `guardCall` 里加的 `finish` 随这两处一起删掉；`tests/unit/finish/*.test.mjs` 与 `tests/ui/fc-app-team.mjs` 里测这两处与 `run.allowed`、
  `gateFor('finish')` 的用例照 finish-check.md §11“被文件系统删掉的代码上的验收”一行改（FC-03、FC-04、FC-18）。
- 用户会话的 TaskBoard 工具照旧在有别的角色或用过协作模式时注册、`defaultActive: false`、之后不增删（平行 Agent 规格 §6.3、`app/src/kernel/team.ts:1376-1406`）。

**删掉的**：

| 删掉 | 位置 | 由什么代替 |
| --- | --- | --- |
| `RoleDef.tools`、角色文件的 `tools` 字段与 `toolProblems`、`PI_TOOL_NAMES`、`MCP_TOOL_PATTERN`、基座的 `tools: null` | `app/src/kernel/roles.ts:23-24`、`39-40`、`87-88`、`210-215`、`311`、`372`、`434` | 无（见下“角色文件里还写着 tools”） |
| `roleTools`、`readClassTools`、`toolAllowlist`、`dialogTools`、`matchesToolEntries`；`roles.ts` 对 `READ_ONLY_TOOLS` 的 import | `app/src/kernel/roles.ts:528-584`、`595-607`、`10`（`hasOtherRoles`、`ALL_MCP_TOOLS` 留着） | `instanceTools`；用户会话的上表（`DIALOG_TEAM_TOOLS`、`INSTANCE_TEAM_TOOLS.create` 照用） |
| `applyDialogTools`、`wasTeamActive`、`userToolNames` 里的 `dialogTools` | `app/src/kernel/team.ts:1391-1455` | `applyDutyTools`；`userToolNames` = 合并会话 `INSTANCE_TEAM_TOOLS.create`，否则 `DIALOG_TEAM_TOOLS`（两者都含 `agent_message`，注册的那一组不变） |
| `guardCall` 里用户会话的分支（`RELAY_ONLY` 与 `<tool> is not one of <role>'s tools.`）、`LaneRun.allowed`、`UserRunStart.allowed`、`nextUserRun.allowed` | `app/src/kernel/team.ts:86-92`、`197`、`1417`、`1516-1524`；`app/src/kernel/teamLanes.ts:102-103`、`193`；`app/src/kernel/teamRuns.ts:47-56` | 对话会话的收窄（§8.3，在路径闸第 2 步）；`userHooks` 不再要 `toolCall` |
| `offRestore`、`lastOffTools`、`mori.team` 的 `tools`（写与读） | `app/src/kernel/team.ts:94-113`、`186-189`、`259-262`、`1577-1583`；`app/src/shared/team.ts:344-349` | 不需要：模式改变不再改碰文件的工具，回到关闭模式时没有要恢复的。旧条目里的 `tools` 由 zod 丢掉（`TeamEntrySchema` 是 `z.object`） |
| `Lane.readOnly`、`BoardTask.readOnly`、`CreateTaskInput.readOnly`、`task_create.read_only` | §8.1 表 | `limits`（§8.2、§8.5） |

**留着的**：`guardToolCall`（task 实例交接之后、强制填写的运行里拒绝其他调用，`app/src/kernel/boardTools.ts:420-428`）；`mori-memory` 的写保护（`app/src/kernel/memoryExtension.ts:193-201`）；
`refreshTools`（`app/src/kernel/sessions.ts:591-597`）；TaskBoard 工具按席位注册。

**角色文件里还写着 `tools`**：`roleFileSchema` 是 `z.strictObject`（`app/src/kernel/roles.ts:308`），去掉 `tools` 之后它就是未知字段，走现有的启动校验（平行 Agent 规格 §4.4）：
会话按 `agents_invalid` 拒绝启动，卡片 `Fix the agent files` 上一行 `<file>: unknown field "tools"`，删掉这一行后 `Check again`。不另写原文，也不悄悄忽略。

**旧会话恢复出来的工具组合**（负责人 2026-10-26 定，见 [§0](file-system.md)“写规格时定的”；2026-10-27 注：合并的那条线有 Customize › Built-in tools 的开关（WP-08），重新打开的会话的内置工具按现在的 `defaultTools` 换（`reopenedTools`），所以拒绝只看现在的默认工具里旧版本会收窄掉的 `bash`、`edit`、`write`，开关打开 ls、grep、find、powershell 之后旧会话照样能打开，见 docs/v1/walkthrough-1026-checks.md 的 U56）：旧版本在协作模式下（读取类）或给写了 `tools` 的对话角色收窄过启用的工具，
pi 重新打开会话时按会话记录恢复那一组（§8.1），而 `applyDutyTools` 不动碰文件的工具，这些会话的对话 Agent 就会一直缺 `bash`、`edit`、`write`。Mori 不补工具，拒绝打开：

- 重新打开已保存的用户会话时（`app/src/kernel/sessions.ts:435`，在 `refreshTools` 之前，也就在绑定扩展之前），pi 恢复出来的启用工具（`getActiveToolNames()`）里只要缺了这个会话应有的
  pi 默认工具（pi 设置的 `defaultTools`，即 `TeamArgs.baseTools`，`app/src/kernel/sessions.ts:474`；没设时 `read`、`bash`、`edit`、`write`），就抛出
  `This session was saved by an older version of Mori and can’t be opened.`：照现在建立失败的做法收拾（`app/src/kernel/sessions.ts:448-451`），会话不打开，`session.open` 失败，界面显示这句（验收 FS-68）。
- **pi 怎样记下与恢复启用的工具**（本规格复核时在 pi 1.3.0 上核对）：每次请求之前，pi 把这次请求的工具与会话里已声明的之差写成一条 system 消息的
  `toolsAdded` / `toolsRemoved`（`agent-loop.js:209-245` 的 `declareToolChanges`），随会话写盘；重新打开、建 `AgentSession` 时（只在不传 `tools` 白名单时，
  用户会话就是这样）按这些消息重放出最后的一组并启用（`agent-session.js:214-215`、`:1374-1382`；重放规则在
  `app/node_modules/@earendil-works/pi-ai/dist/utils/transcript.js:41-52`），早于 `session_start` 与扩展的绑定。所以扩展在 `session_start` 或
  `before_agent_start` 里用 `setActiveTools` 关掉的工具，之后只要发过一次请求就记进了会话文件，重新打开时照样恢复成关掉后的那一组；关掉之后一次请求都没发的
  不留记录；会话文件里还没有 system 消息（一次请求都没发过）时 pi 不恢复，按默认的一组启用（`agent-session.js:1377-1378`）。恢复出来的组合里也有扩展工具的名字（`memory`、`ask_user_question`、TaskBoard 工具，
  由扩展注册，`refreshTools`（补上已注册、恢复的组合里缺的扩展工具）与 `applyDutyTools` 处理），所以上一条只比 pi 设置的默认工具在不在里面，不比扩展工具（FS-65、FS-68）。
- 不补工具，也不为旧数据另写分支；`refreshTools` 补扩展工具的做法不变（`app/src/kernel/sessions.ts:586-590` 的原则：照 Claude Code，恢复会话时用现在的工具）。
- Mori 没有让你停用内置工具的地方（Customize 的 Built-in tools 只读，`app/src/renderer/src/components/ToolsBuiltin.tsx:1-2`），新版本又不再收窄碰文件的工具，所以恢复出来的组合缺默认工具，
  只会因为旧版本的收窄，或你之后在 pi 设置的默认工具里加了工具；两种都按第一条拒绝打开（后一种见 [§0](file-system.md)“已知的限制”）。

### 8.7 写入锁

- `scheduleStarts`（`app/src/kernel/boardRoute.ts:54-80`）第 69、75 行的 `!task.readOnly` 改为 `writesFiles(task)` = `task.limits.write !== false`：`limits` 为 `{}`、只写了 `commands: false`、`mcp: false` 或 `write_paths` 的 task
  都是写 task，在第一个实例开始时取 `board.lock`，持有到 task 结束（`app/src/kernel/board.ts:317-323`，不变）；`write: false` 的 task 不取锁，随时可以并行。
- “同一时间只有一个 task 写工作区”（平行 Agent 规格 §9.2、proposal 规则 8）照旧成立：立项、结案、订阅、临时提问被程序收窄为 `write: false`，协作模式下对话会话为
  `{ write: false, mcp: false }`（§8.3），能写文件的只有写 task。
- 已知限制（proposal §13 第 2、3 条接受的）：`write: false` 的会话仍能用 MCP 与扩展工具，Mori 看不出它们写什么；命令分析认不出的写入（§7）同样不受锁约束。
  锁仍只约束这个用户会话里 Mori 派出的 Agent，不是文件系统锁（同现在）。

### 8.8 已存的 `board.json`

- 现在：`loadBoard`（`app/src/kernel/board.ts:1039-1054`）按 `BoardSchema` 校验，不合格就记日志并抛出 `<path> is not a valid TaskBoard: <issues>`，`attachTeam` 把错误交出去，
  会话打不开（`app/src/kernel/sessions.ts:526-537`）。`BoardTaskSchema` 是 `z.object`（`app/src/kernel/teamTypes.ts:159`），不认识的键被丢掉、不报错（zod 4.6.7）。
- 本规格（负责人 2026-10-26 定：“我们不做兼容，就是打不开”，见 §0）：`BoardTask.limits` 必填，没有限制的 task 写 `{}`（§8.2）。当前版本存下的 `board.json` 里 task 带 `readOnly`、
  没有 `limits`，校验不过（`tasks.<n>.limits` 缺失），这个会话按现在读不出 TaskBoard 时的处理和提示打不开（错误原文 `<path> is not a valid TaskBoard: …`）。
- 不写转换代码（把 `readOnly: true` 换成 `limits: { write: false }` 是兼容代码，AGENTS.md 不允许），也不把 `limits` 做成可选、缺省为不限。

### 8.9 模型看到的限制

改动都在平行 Agent 规格附录 A 的段、它 §8.5 的投递文字、工具说明和工作卡里（全文见 §14），合成端点认会话种类用的各段第一句不变（平行 Agent 规格 §17.1，`SEGMENT_SENTENCES`）：

- `task_create`：说明与 `limits` 参数的说明写明每一项的意思；Correct form 不再带 `read_only`。
- 立项段与合并会话的立项段：原来的 “Mark a task read_only unless it must run commands or change files.” 换成写 `limits` 的同一条建议（默认仍是只读，保住并行与写入锁的现状）；
  并写明它自己不能改文件、跑命令。
- 对话段（协作模式、分开时）、结案段、临时提问段、订阅段、临时提问的投递：写明不能改文件、跑命令（以前工具列表里就没有，现在工具在、调用被拒绝）。
- 对发起方说临时提问能做什么的文字不变：`agent_message` 的两段说明（`ASK_DESCRIPTION`、`TEAM_MESSAGE_DESCRIPTION`，`app/src/kernel/boardTools.ts:195-202`）与关闭模式的对话段
  （`app/src/kernel/boardText.ts:440-443`）。它们说的“read-only”“cannot change files”仍然成立；关闭模式对话段的第一行就是合成端点认种类的那一句（`app/tests/fake-endpoint/scripts.mjs:82`），不能改。
  `agent_message` 只加 `limits` 参数与它的说明。
- task 实例：工作卡 task 那一行与 `board_read` 带 `task` 的第一行写这个 task 的限制（`limitsText`）；task 实例段不变。
- 被拒绝时的工具结果就是 §8.4 的原文。
- 这些都改了模型看到的文字：按 AGENTS.md 重录用到它们的 fixture（`tests/fixtures/tb/`），用真实模型走一遍（FS-67）。

### 8.10 增强会话

- **模式**：`userApproval`（`app/src/kernel/sessions.ts:482-486`）的 `setMode('all')` 改为 `new ApprovalPolicy({ mode: 'full', canAsk: false })`（§6.7、§6.11）。它的实例共用这一份（`InstanceSpec.approval`），同现在。
- **write、edit**：`mori-memory` 在增强会话和它的全部实例里照旧一律拒绝，不论路径（`Enhancement runs can only change memory, with the memory tool.`，`app/src/kernel/memoryExtension.ts:31`、`195`；记忆规格 §9.6）。
  `mori-memory` 的 `tool_call` 排在 `mori-approval` 之前（`app/src/kernel/sessions.ts:316-317`），所以写 `.work` 也被它拒绝。
- **命令与 MCP**：Full access 下工作路径里的命令、MCP 与扩展工具不出卡就执行（同现在）；§7 分析出写到工作路径外或受保护路径的命令（§6.4 的 scope 为 `outside` 或 `protected`，
  含看不出目标、换到工作路径外执行的、分析不了的），在路径闸第 3 步**直接拒绝**，不出卡、不计时，因为没人能批（proposal §13 第 20 条）。拒绝原文是 §6.15 的 `Denied by Mori: nobody can approve …`。
- **谁算没人能批**：增强会话本身（`isHeadless`，`app/src/kernel/sessions.ts:387-389`、`418`）和它的 Team 开的全部实例。`canAsk` 是 `ApprovalPolicy` 的构造选项（§6.11），
  实例经 `InstanceSpec.approval` 共用同一份，所以不另加字段，`GateOutput`、`InstanceSpec` 都不用带这一项。
- **协作模式下的增强**：§8.3 的收窄照常（立项、结案 `{ write: false }`，合并会话 `{ write: false, mcp: false }`，task 按立项写的 `limits`）。
- **给模型的文字**：记忆规格附录 A.3 与附录 B 不变，它们的 “Commands and MCP tools run without approval: never use them to change anything” 对工作路径里的命令仍然成立；
  身份段的权限句按 §6.16 用“没人能批”那一句（由 §6 写）；写到外面的命令被拒绝时，模型从工具结果看到原因。

## 9. 你不在

proposal §1 第 6 条、§4“你不在”、§5.2、§6、§9 第 6 条、§12 第 9、10 条、§13 第 6 条。代码在 `kernel/away.ts`（新）：焦点状态、计时、到时的默认答案、记录、`agent_before_settle` 提醒。
它不自己判断要不要出卡，只接管已经挂起的卡；出卡的判断见 §6.1（第 5 步）。

### 9.1 焦点：主进程告诉后台进程

**现在**：只有主进程知道窗口焦点。`app/src/main/index.ts:84-85` 在 `focus` 时停止任务栏闪烁；`mori:attention`（`app/src/main/index.ts:144-148`）出卡时用 `isFocused()` 判断要不要 `flashFrame(true)`。
后台进程没有焦点信号：`MainToKernel` 只有 `port`、`start`、`store-key-result`、`shutdown`（`app/src/kernel/index.ts:88-93`）。界面只知道哪一栏有焦点（`state/split.ts`），不算（proposal §4：只按整个窗口算）。

**改成**：

| 项 | 做法 |
| --- | --- |
| 消息 | `MainToKernel` 加 `{ type: 'window_focus'; focused: boolean }`，`kernel/index.ts` 收到后调用 `away.setFocus(focused)` |
| “在前台”的定义 | `focused = !window.isDestroyed() && window.isFocused() && !window.isMinimized()` |
| 何时发 | `createWindow` 里给窗口挂 `focus`、`blur`、`minimize`、`restore` 四个事件，每次按上式重算；与上次发出的值相同时不发（proposal §7“只在焦点变化时发”） |
| 接上通道时 | `connectWindow`（页面每次加载、`mori:restart-kernel` 重启后台进程都会调用，`app/src/main/index.ts:41-54`）发出 `port` 之后，把“上次发出的值”清掉再按当前状态发一次。新起的后台进程不知道窗口状态，所以这一次即使值没变也要发 |
| 后台进程的初值 | `focused = true`：主进程第一次告诉它之前没有窗口，也就没有卡 |
| 先于 `start` 到达 | `start` 在子进程 `spawn` 之后才发（`app/src/main/kernel-process.ts:51-55`），`port` 与 `window_focus` 可能先到：`setFocus` 只改内存里的状态，不依赖 `startAway` |
| 日志 | 后台进程每收到一次记一行 `[kernel] window focus: <true\|false>`（FS-69 据此核对“值不变时不发”） |
| 任务栏闪烁 | 不变：`focus` 时 `flashFrame(false)` |

分屏、焦点在另一栏、设置页挡住了会话、DevTools 有焦点，都不算“你不在”（只看窗口）。

### 9.2 哪些挂起的请求计时

| 请求 | 在哪里挂起（现在的代码） | 计时 | 到时 |
| --- | --- | --- | --- |
| 用户会话自己的批准卡 | `ApprovalGate.request`（`app/src/kernel/approval.ts:190-204`），`mori.approval_request` | 是 | 拒绝（§9.4） |
| 后台实例的批准卡 | 同一个类，实例的 gate 经 `GateOutput.onRequest` 交给 Team，在用户会话的信封上发 `mori.team_approval_request`（`app/src/kernel/team.ts:1336-1345`） | 是 | 拒绝，结果回给那个实例 |
| 提问卡（`ask_user_question`） | `kernel/askQuestion.ts`（新，§10），`mori.question_request` | 是 | 按推荐项回答 |
| 扩展的确认、选择、输入卡 | `ExtensionUi.ask`（`app/src/kernel/extensionUi.ts:99-120`），`mori.ui_request` | 是 | 取消（proposal §13 第 6 条：pi 的这三种没有推荐项字段，`dist/core/extensions/types.d.ts:40-45`） |
| 实例会话、增强任务的看不见的会话里的扩展询问 | `ExtensionUi` 以 `blocked = 'instance'` 建立，询问直接按取消回答、不出卡（`app/src/kernel/extensionUi.ts:42-44、103-105`） | 不涉及 | — |
| 看不见的会话的批准 | 增强会话的 `ApprovalPolicy` 是 `{ mode: 'full', canAsk: false }`，写到外面或受保护路径直接拒绝、不出卡（§6.11、§8.10，proposal §13 第 20 条） | 不涉及 | — |
| 界面自己的对话框（信任、确认、离开） | 只在界面里，不挡住 Agent | 不计时 | — |

每个计时的请求在 away.ts 里登记一项：

```ts
/** @brief 一个交给无人应答模块计时的挂起请求。 */
interface AwayItem {
  /** 卡片所在的用户会话（实例的请求为它所属的用户会话）：mori.away_timer 发在它的信封上 */
  userSessionId: string;
  /** 发起请求、被挡住的 pi 会话（用户会话自己，或某个实例）：提醒清单（§9.8）按它记 */
  sessionId: string;
  /** 请求 id：approval-<n>、<实例的 pi 会话 id>:approval-<n>、ask-<n>、question-<n> */
  requestId: string;
  /** 发起请求的会话种类（批准卡取自 GateOutput.kind；提问卡与扩展询问为 'user'）：到时原文与提醒的最后一句按它选（§9.4、§9.8） */
  kind: 'user' | InstanceKind;
  /**
   * @brief 到时：按默认答案结束这个请求（§9.4）。
   * @param timeout 当时的时长
   * @return 这次自动处理的记录（agent 为 null）；请求已经结束时为 null
   */
  expire(timeout: Exclude<AwayTimeout, 'never'>): AwayDecision | null;
}
```

- **先发请求事件，再登记**：`ApprovalGate.request`、`askQuestion.ts`、`ExtensionUi.ask` 都先发出请求事件（`mori.approval_request`，或经 `onRequest` 由 Team 同步发
  `mori.team_approval_request`，`app/src/kernel/team.ts:1337-1345`；`mori.question_request`；`mori.ui_request`），再向 away.ts 登记；登记时发出的 `mori.away_timer`
  因此总在请求事件之后到达界面。界面对不认识的 `requestId` 的 `mori.away_timer` 忽略（`LiveSnapshot.awayTimers` 不受影响）。`finish` 时注销（不论怎么结束）。
- `GateOutput` 加三项：`kind`（§8.5，登记时抄进 `AwayItem.kind`，away.ts 拼原文时不必回头找 gate）；`userSessionId`（用户会话的 gate 为自己的会话 id，
  `app/src/kernel/sessions.ts:511` 建；实例为 `spec.owner`，`app/src/kernel/instances.ts:65` 建）；`handedOff?(): boolean`（只有实例有：这次运行里已经成功交接，
  读 `lane.run.handedOff`，`app/src/kernel/team.ts:1525`；Team 在实例的设置 `InstanceSpec` 里给出，同 §8.5 的 `narrowing`，`instanceSetup`（`app/src/kernel/instances.ts:62-72`）放进 `gate`；§9.8 用）。
- `askQuestion.ts`、`ExtensionUi.ask` 同样在发出请求事件之后登记、结束时注销。三种请求 id 前缀不同（`approval-`、`ask-`、`question-`），在一个用户会话的信封上不会重名。
- away.ts 自己不 import 会话模块：`startAway({ userData, emit, record })` 由 `kernel/index.ts` 在 `start` 时调用，`emit` 是 `index.ts` 的广播，
  `record(userSessionId, decision)` 是 `sessions.ts` 导出的写记录函数（§9.7）。

### 9.3 计时规则

away.ts 只有一份全局状态（后台进程里只有一个窗口）：`focused`、当前时长（§9.6）、登记的项、每项的计时器。

| 时刻 | 做什么 |
| --- | --- |
| 登记一项，`focused` 为真 | 只记下，不计时（窗口在前台时卡片一直等，同现在） |
| 登记一项，`focused` 为假，时长不是 Never | 立刻开始计时：`deadline = Date.now() + 时长`，`setTimeout(expire, 时长)`，在 `userSessionId` 的信封上发 `mori.away_timer { requestId, deadline }`（登记在请求事件之后，所以它晚于那张卡到达，§9.2） |
| `setFocus(false)`（从真变假） | 对每个登记的项开始计时，规则同上；所有项的 `deadline` 相同 |
| `setFocus(true)`（从假变真） | 清掉全部计时器；对每个正在计时的项发 `mori.away_timer { requestId, deadline: null }`。卡片接着等 |
| 再次 `setFocus(false)` | 从头计时（不接着上次剩下的时间：proposal §5.2“切回 Mori，计时清零”） |
| 项注销（请求结束） | 清掉它的计时器；不发 `mori.away_timer`（界面随请求的结束事件去掉卡片） |
| 计时器到时 | 调用 `expire(timeout)`（§9.4），这一项注销。返回了记录时：记进 `sessionId` 的提醒清单（§9.8）；`sessionId === userSessionId`（用户会话自己的请求）时再交给 `record` 写进会话文件并发事件（§9.7）。后台实例的批准由 Team 写记录（§9.7），away.ts 不写 |
| 时长为 Never | 不计时，从不发 `mori.away_timer` |

- 一项一个 `setTimeout`，数量等于挂起的卡片数，不轮询（负责人偏好）。挂起的卡片数本身有上限：每个 pi 会话的工具调用按顺序执行
  （`app/src/kernel/sessions.ts:431`），一个会话同一时刻至多一张批准卡或提问卡，另加扩展询问。
- 几张卡同时挂着时，界面一次只显示一张（`app/src/renderer/src/components/ApprovalCard.tsx:268-286`），但每一张都在计时，到时一起按默认处理。
- 时钟可以注入（同 `enhance.ts` 的 `EnhanceClock` / 模型池的 `PoolClock`：`now`、`setTimeout`、`clearTimeout`），单元测试用它驱动。
- 测试用的时长：环境变量 `MORI_AWAY_TIMEOUT_MS` 有值时，三档时长都换成这个毫秒数（Never 仍是不计时），写法照 `MORI_USER_DATA`；只给测试用，界面不显示。
  主进程把自己的环境原样交给后台进程（`app/src/main/kernel-process.ts:40-46`），所以设在启动 Mori 的环境里即可。只换毫秒数：原文里的时长、记录的 `timeout` 仍按设置写。

### 9.4 到时的默认答案

| 请求 | `expire()` 做什么 | 回给谁的原文 |
| --- | --- | --- |
| 用户会话自己的批准卡 | `gate.finish(requestId, 'reject', 'away', 原文)`；`ApprovalEndBy` 加 `'away'`（`app/src/shared/protocol.ts:655`） | pi 把 `reason` 作为工具结果回给模型（`app/src/kernel/approval.ts:216-217`）：自动拒绝的原文（用户会话写进最后的总结，见 §14） |
| 后台实例的批准卡 | 同上，结束事件经 `GateOutput.onEnd` 交给 Team，Team 照常发 `mori.team_approval_end { by: 'away' }`（`app/src/kernel/team.ts:1348-1352`） | 回给那个实例的模型。最后一句按 `GateOutput.kind`（经 `AwayItem.kind`）选：`task`、`close` 用 “Mention it in your handoff.”，`user`、`create`、`ask`、`subscription` 用 “Mention it in your final summary.”；不从 `narrowing()?.owner` 推断（`limits` 为空时它是 null） |
| 提问卡 | 每个问题按 `recommended` 回答（`auto: true`），`mori.question_end { by: 'away' }`（§10.5） | 工具结果：提问卡到时的原文（§14） |
| 扩展询问卡 | `ExtensionUi.finish(requestId, null)`：同现在的取消，确认为 false，选择、输入为空（`app/src/kernel/extensionUi.ts:91-97、126-134`） | 回给扩展，不回给模型 |

- 拒绝原文里的时长写当时的设置：`60 seconds`、`5 minutes`、`10 minutes`。
- 界面认出这句：前缀 `REJECTED_AWAY_PREFIX = 'The user was away and didn’t answer within '` 是 §6.15 `DENIAL_PREFIXES`（`shared/workspace.ts`）里的一项，
  `app/src/renderer/src/state/model.ts:292` 的 `parseRejection` 认出它，工具卡显示 `Denied · No answer while you were away`（重新打开会话时同样）。提问卡到时的工具结果（§14）开头相同，
  但它不是 `isError`，重新打开时 `app/src/renderer/src/state/history.ts:68` 只对 `isError` 的结果调用 `parseRejection`，实时也只从 `mori.approval_end` 认，两者不会混。
- 卡上没提交的选择不算：提问卡到时一律用推荐项（后台进程不知道界面上点了什么）。
- 每次自动处理都写一条记录（§9.7），并记进这次运行的提醒清单（§9.8）。

### 9.5 与停止、关闭、模式切换

计时只跟着请求走：请求不论怎么结束，计时器都在注销时清掉。

| 情况 | 现在 | 计时 |
| --- | --- | --- |
| 你在卡上回答 | `approval.answer`、`ui.answer`、`question.answer` | 请求结束，清掉；与到时同时发生时先到的那一个生效，另一个是“no longer pending”（`app/src/kernel/approval.ts:226`，扩展、提问同样），界面已收到结束事件 |
| Esc / 停止对话的回复 | `stopRun`（`app/src/kernel/sessions.ts:1109-1122`）：`ui.beginStop()`、`gate.rejectForStop()`、`session.abort()`；提问按 §10.6 | 对话自己的卡结束，清掉；后台实例的卡不变（`docs/v1/screens/team-approvals.md`），继续计时 |
| `Stop team` | 每个 lane 的 `rejectForStop`（平行 Agent 规格 §11.4） | 全部结束，清掉 |
| 停止过程中新到的请求 | 直接按停止拒绝或取消，不出卡（`app/src/kernel/approval.ts:180`、`app/src/kernel/extensionUi.ts:103-105`） | 不登记 |
| 会话关闭（归档、删除、退出） | `gate.close()`、`ui.close()`（`app/src/kernel/sessions.ts:782-786`） | 清掉 |
| `ctx.signal` 中止 | `finish(…, 'closed')`（`app/src/kernel/approval.ts:194`） | 清掉 |
| 切到 Full access、`Allow for this session`、按目录放行 | §6：挂起的同名或同目录的请求按允许结束 | 清掉 |
| 后台进程重启 | 挂起的请求都作废（平行 Agent 规格 §11.6） | 计时器随进程消失 |
| 界面重新载入（Ctrl+R） | `LiveSnapshot` 交出挂起的卡 | 后台进程照常计时；`LiveSnapshot` 加 `awayTimers: { requestId, deadline }[]`（正在计时的项），界面接着显示倒计时 |

### 9.6 设置：When you’re away

**现在**：Mori 没有全应用的设置文件。设置页三节 Models、AGENTS.md、UI issues（`app/src/renderer/src/components/SettingsPage.tsx:14-18`）；
模型配置在 `<userData>/model-config.json`，增强设置按项目在 `enhance.json`，界面的偏好在 localStorage（`state/layout.ts`、`state/archive.ts`）。
后台进程从 `start` 消息拿到 `userData`（`app/src/kernel/index.ts:98-110`）。

**改成**：

| 项 | 值 |
| --- | --- |
| 取值 | `AwayTimeout = '60s' \| '5m' \| '10m' \| 'never'`，默认 `'5m'`（proposal §5.2）；毫秒 60000、300000、600000、不计时 |
| 存放 | `<userData>/away.json`：`{ "timeout": "5m" }`，用 `app/src/kernel/agents.ts:18` 的 `writeFileAtomic` 写。不放 localStorage：后台进程要用它 |
| 读 | `kernel/index.ts` 收到 `start` 时调用 `startAway({ userData, emit, record })`（§9.2）读一次；文件不存在时用默认；读不出或值不对时用默认并记错误日志，`away.get` 的 `error` 带原文。读完之前用默认值（这时还没有会话，也就没有卡） |
| 命令 | `away.get {}` → `{ timeout, error }`；`away.set { timeout }` → `{ timeout, error }`：先写文件，成功后改内存里的值；写不出时 `error` 为原文、值不变。zod 定义在 `shared/workspace.ts`，并入 `CommandSchema`；`kernel/commands.ts` 分发 |
| 生效 | 下一次开始计时起。改设置要在 Mori 里点，那时窗口在前台、没有正在走的计时，所以不用重算正在走的计时 |
| 界面 | 设置页新增一节 `General`（排在 UI issues 之后），一行 “When you’re away”，见 `docs/v1/screens/fs-question.md`“设置页”；§11 的 Clean up worktrees 在另一节 `Storage`，两节都留 |

### 9.7 记录：`mori.away_decision`

每次自动处理写一条，既是事件，也是用户会话文件里的自定义条目（同名，`appendCustomEntry`，不进模型上下文）。

```ts
/** @brief 一条自动处理记录（mori.away_decision 的事件与会话条目）。 */
interface AwayDecision {
  /** 请求 id */
  requestId: string;
  /** 批准卡 / 提问卡 / 扩展询问卡 */
  kind: 'approval' | 'question' | 'extension';
  /** 处理的时刻（ms） */
  at: number;
  /** 当时的时长（不会是 never） */
  timeout: Exclude<AwayTimeout, 'never'>;
  /** 后台实例的请求：哪个实例、角色、task；用户会话自己的 Agent 为 null */
  agent: { instance: string; role: string; task: string | null; taskTitle: string | null } | null;
  /** 工具调用 id；扩展询问为 null */
  toolCallId: string | null;
  /** 批准卡的工具名；提问卡为 ask_user_question；扩展询问为 null */
  toolName: string | null;
  /** 批准卡的参数：每个字符串截到 300 字符，去掉 content 与 edits（界面只用它算工具卡标题）；其余为 null */
  args: Record<string, unknown> | null;
  /** 扩展询问的标题；其余为 null */
  title: string | null;
  /** 提问卡用上的推荐项（AskAnswer，§10.5）；其余为 null */
  answers: AskAnswer[] | null;
  /** 拒绝 / 推荐项 / 取消 */
  result: 'denied' | 'recommended' | 'cancelled';
}
```

| 谁写 | 写到哪里 | 时机 |
| --- | --- | --- |
| 用户会话自己的批准、提问、扩展询问 | 用户会话的会话文件；事件发在它的信封上 | `expire()` 之后，away.ts 调用 `record(userSessionId, decision)`（`sessions.ts` 导出）：有 Team 时经 `Team.writeUserEntry`（`app/src/kernel/team.ts:1288-1300`：对话正在输出时等这条助手消息结束再写，平行 Agent 规格 §14.6 T-S6），没有 Team 时 `appendCustomEntry` 后在信封上发事件 |
| 后台实例的批准 | **用户会话**的会话文件（不写实例自己的文件）；事件发在用户会话的信封上 | Team 在 `onApprovalEnd`（`app/src/kernel/team.ts:1348-1352`）看到 `by === 'away'` 时，在删掉 `approvals` 里那一项之前取卡上的 `role`、`task`、`taskTitle`、`toolName`、`args` 填记录（`timeout` 取 away.ts 当时的设置），经 `writeUserEntry` 写。away.ts 只把 `expire()` 的返回记进那个实例的提醒清单 |

- 实例自己的模型从工具结果知道这件事（§9.4）；用户会话的列表列出全部（proposal §5.2）。
- 会话文件里的条目在重新打开会话、界面重新载入后照样显示（`renderer/src/state/history.ts` 读它，同 `mori.ref`、`mori.wake`）。
- 不进 F8 报告的“最近的操作”：不是你的操作。

### 9.8 `agent_before_settle` 提醒

**pi 的入口（已核实）**：`AgentBeforeSettleEvent` 带 `entries`、`continue`、`context`、`outcome: 'completed' | 'aborted' | 'error'`；处理器返回 `BoundaryResult { entries?, continue? }`
（`app/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:752-799`）。
`AgentSession._runBeforeSettleBoundary`（`dist/core/agent-session.js:1537-1559`）提交 `entries`，`continue` 为真且上下文能接着请求时再跑一次请求（同一次运行，`agent_settled` 推后）；
你按了停止时根本不调用它（`agent-session.js:1426`）。`custom_message` 条目进模型上下文、作为 user 消息发出（`dist/core/messages.js:89-96`，`session-manager.js:179-183`），`display` 只管 pi 自己的终端界面。
`ExtensionRunner.emitBoundary`（`dist/core/extensions/runner.js:759-803`）用处理器返回的 `entries` **替换**累计的数组，所以要返回 `[...event.entries, 新条目]`。
**一次运行里 `agent_start` 不止一个**：pi 的运行（`prompt()` 到 `agent_settled`）里，重试、压缩后接着跑、排队的消息和这里的 `continue` 都调用 `agent.continue()`
（`agent-session.js:1418-1430`），每次都再发一个 `agent_start`（`app/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:59-70`）；`agent_settled` 每次运行只发一次（`agent-session.js:1440`，在 `finally` 里）。
（2026-10-27 注：收尾检查，见 [finish-check.md](finish-check.md) §8.1、§11）提醒的 `continue` 再发的 `agent_start` 不能另起 Team 的运行记录（`LaneRun`）：`runStarted`（`app/src/kernel/teamRuns.ts:45-66`）在 `lane.run !== null` 时直接返回，
强制填写的运行另在 `compaction_end { willRetry: true }` 时清 `assistants`、`formMode`。收尾检查先落地时这已经在代码里；文件系统先落地时由本节的实现带上这一改动与 finish-check.md FC-18 的单元用例。

**做法**：

| 项 | 规则 |
| --- | --- |
| 谁注册 | `mori-approval` 的工厂（`app/src/kernel/approval.ts:163-167`）加 `pi.on('agent_before_settle', …)`：每个会话（用户会话、各种实例）都有这个扩展。处理器调用 `away.reminder(sessionId, event)` |
| 清单 | away.ts 按 pi 会话 id（`AwayItem.sessionId`）记这次运行里的自动处理：批准（工具名、`args`）与提问（`answers`）。`sessions.ts` 的 `forward` 在 `agent_settled` 时（`app/src/kernel/sessions.ts:188-191`）清空这个会话的清单和“已提醒”标记。不在 `agent_start` 清：同一次运行里它会再来（上面最后一段），在那里清会丢掉重试之前的记录，`continue` 之后又会清掉“已提醒”而再补一次。挂起的卡只出现在运行之中（扩展询问除外，它不进清单），所以运行之间清单总是空的 |
| 什么时候补 | 同时满足：清单不空；这次运行还没补过；`event.outcome === 'completed'`；不是“已交接的 task 实例”：gate 的 `GateOutput.handedOff?.()` 为真时不补（交接之后的调用一律被拒绝并结束运行，`app/src/kernel/boardTools.ts:420-428`，再跑一次没有用） |
| 补什么 | 返回 `{ entries: [...event.entries, { type: 'custom_message', customType: 'mori.away_reminder', content: <提醒原文>, display: false }], continue: true }`；标记“已提醒” |
| 不补时 | 返回 `undefined`：pi 的行为与没有处理器时相同（`agent-session.js:1538-1539` 对比 `1549-1557`） |
| 只补一次 | 补过之后，同一次运行里新的自动处理（多跑的那次请求里又被拒绝的调用）不再补；它们的工具结果原文已经要求写进总结 |
| 扩展询问 | 不进清单：模型没有发起它、也没见过那张卡（临时默认值）。界面的列表照样列出 |
| 界面 | 这条 `custom_message` 不显示：`app/src/renderer/src/state/history.ts:181` 只画 `message` 条目（另认几种 `custom`），不画 `custom_message`；实时也没有它的 `message_start`（pi 提交边界条目只发 `entry_appended`，`agent-session.js:636-641`，界面不处理这个事件）。多跑的那次请求的回复接在这一轮的回复后面 |
| 在上下文里的位置 | 提醒接在最后一条助手消息之后；有工作卡的实例，mori-team 的 `context` 钩子每次请求把工作卡接在最后（`app/src/kernel/teamExtension.ts:56-59`），所以提醒是倒数第二条 user 消息。（2026-10-27 注：收尾检查，见 [finish-check.md](finish-check.md) §6.4、§11）用户会话里同一个边界多半也加了收尾检查，顺序是 [最后一条助手消息，检查那一行（含检查块），提醒，工作卡]：提醒跟在检查那一行之后，不紧跟助手消息；有工作卡时仍是倒数第二条 user 消息。实例会话没有收尾检查，不变 |
| 代价 | 多一次模型请求（proposal §12 第 10 条）；这期间会话仍在运行，等 `agent_settled` 的 TaskBoard 投递晚一次请求（proposal §14，验收 FS-79）。（2026-10-27 注：收尾检查，见 [finish-check.md](finish-check.md) §11）用户会话里与收尾检查同一个边界时合成一次请求，提醒不另多一次 |

清单里的批准行：`- Denied <工具名>`，`edit`、`write` 加 `: <path>`，`bash`、`powershell` 加 `: <command 的第一行，截到 80 字符，截掉时加 …>`。
提问行：每个问题一行 `- Used your recommended option for "<question>": <label>`。
提醒最后一句按清单里记下的 `AwayItem.kind` 选（同 §9.4）：`task`、`close` 为 `Don't retry the denied calls. Mention all of these in your handoff.`，
`user`、`create`、`ask`、`subscription` 为 `… in your final summary.`（§14）；不从 `narrowing()?.owner` 推断。

### 9.9 界面

状态表见 `docs/v1/screens/fs-question.md`。要点：

- **倒计时**：卡片收到 `mori.away_timer` 的 `deadline` 后，剩下 ≤ 20 秒时显示一行。界面不自己计时（proposal §7）：卡什么时候结束由后台进程决定，
  界面只按 `deadline` 显示剩下的秒数：剩下多于 20 秒时只设一个到 `deadline − 20 秒` 的 `setTimeout`，进入最后 20 秒才每秒重画一次
  （用 `app/src/renderer/src/components/QuestionCard.tsx:55` 现在给 `This request expires in N seconds` 用的 `useNow`）；`deadline: null` 或卡结束时清掉：
  批准卡（对话的、后台的）`You’re away · Denying in 12s`；提问卡 `You’re away · Using the recommended options in 12s`；扩展询问卡 `You’re away · Cancelling in 12s`。`deadline: null` 时去掉。
- **一轮末尾的 “Decided while you were away”**：按 `mori.away_decision`（实时的事件、重新打开时的条目）在这一轮的最后画一块，由程序生成，不靠模型（proposal §6）。
  “一轮”同 proposal §4：你的一条消息到下一条之间，程序投递（`mori.wake`）不另起一轮。
- **任务栏闪烁**：`mori.question_request` 也调用 `requestAttention`（同 `app/src/renderer/src/state/actions.ts:362、438` 的两种批准请求），窗口不在前台时闪烁。扩展询问不变（不闪）。
- **侧栏与阶段行**：提问卡挂着时会话行 `Needs input`、阶段行 `Waiting for your answer`（沿用扩展询问的写法，`sessionRows.ts`、`app/src/renderer/src/components/StageLine.tsx:45-47`）。

## 10. `ask_user_question` 工具

proposal §3、§6“提问卡”、§7 工具表、§12 第 8 条、§13 第 5、6、7 条。代码在 `kernel/askQuestion.ts`（新）。

### 10.1 注册与哪些会话有它

**现在**：pi 没有提问工具（内置工具只有 bash、edit、find、grep、ls、powershell、read、write）；`recommend` 在 `app/src` 里不出现。
Mori 的 inline extension 顺序是 mori-models、mori-team（有 Team 时）、mori-memory、mori-approval、mcp（`app/src/kernel/sessions.ts:316-317`）。

| 项 | 规则 |
| --- | --- |
| 注册 | 新的 inline extension `mori-question`（工厂在 `askQuestion.ts`），只加进**用户会话**、且不是增强任务的看不见的会话（`isHeadless`，`app/src/kernel/sessions.ts:387-389`）。放在 mori-memory 之后、mori-approval 之前；它没有 `tool_call` 处理器，顺序只影响工具清单的次序。`pi.registerTool`，`defaultActive: true` |
| 加载失败 | 不是必需的扩展（`requiredExtension`，`app/src/kernel/sessions.ts:342-347` 不加它）：会话照常打开，加载错误照现在显示 |
| 实例会话 | 不加载这个扩展，工具不存在（照 Claude：subagent 没有 AskUserQuestion；proposal §7） |
| 启用 | 用户会话里一直启用：关闭模式的主 Agent、协作模式分开时的对话 Agent、合并会话（兼立项）。这是按席位给的工具（proposal §5.5 最后一条，同 TaskBoard 工具与 `memory`），但不随模式开关：注册即启用（`defaultActive: true`），§8.6 的 `applyDutyTools` 只增删 TaskBoard 工具与 `memory`，不动它；§8.6 去掉了 `guardCall` 里用户会话的分支，没有拦它的地方 |
| 重新打开会话 | `refreshTools`（`app/src/kernel/sessions.ts:591-597`）照现在把默认启用、还没启用的扩展工具加上，旧会话也有它（缺 pi 默认工具的旧会话按 §8.6 打不开） |
| 批准 | 免批准：在 §6.2 的 `DUTY_TOOLS` 里（由现在的 `FREE_TOOLS`，`app/src/kernel/approval.ts:27`，拆出），路径闸 §6.1 第 1 步放行，`mori.tool_gate` 为 `free`（proposal §13 第 7 条） |
| 收窄 | `limits`（§8）不管它：它不碰文件 |
| 工具页 | 来源写 `Mori`（同 `memory`：`app/src/kernel/resources.ts:234-236` 的 `toolSource` 加上 `<inline:mori-question>`） |

### 10.2 参数

照 Claude AskUserQuestion 的格式（1–4 个问题、每个 2–4 个选项、`multiSelect`、Other；`header` ≤ 12 字符），Mori 加必填的 `recommended`。JSON Schema 参数，写法同 TaskBoard 工具（`boardTools.ts`）。

```ts
/** @brief 一个问题（ask_user_question 的参数项，也是 mori.question_request 里的一项）。 */
interface AskQuestion {
  /** 完整的问题，1–500 字符 */
  question: string;
  /** 卡上的短标签，1–12 字符，例如 Database */
  header: string;
  /** 2–4 个选项 */
  options: { label: string; description: string }[];
  /** 可以选多个 */
  multiSelect: boolean;
  /** 推荐的选项：必须等于某个选项的 label */
  recommended: string;
}
```

| 字段 | schema 里 | 执行时查（不合格整次调用报错，不出卡） |
| --- | --- | --- |
| `questions` | 数组，`minItems: 1`、`maxItems: 4`，必填 | 各问题的 `question` 去掉首尾空白后互不相同 |
| `question` | 字符串，必填 | 1–500 字符 |
| `header` | 字符串，必填，`maxLength: 12` | 不为空 |
| `options` | 数组，`minItems: 2`、`maxItems: 4`，必填；每项 `{ label, description }` 都必填 | `label` 1–60 字符、同一问题里互不相同（不分大小写）、不等于 `Other`（不分大小写）；`description` ≤ 300 字符 |
| `multiSelect` | 布尔，必填 | — |
| `recommended` | 字符串，必填 | 等于这个问题某个选项的 `label`（去掉首尾空白后逐字比较） |

- 数量与必填由 pi 在执行前校验，原文为 pi 的 `Validation failed for tool ask_user_question …`（同 memory 工具，[记忆规格](memory.md) §7.1）。
- 不写 `prepareArguments`：`app/src/kernel/boardTools.ts:333-343` 的 `prepareToolArgs` 只归一顶层的键（还按名字改写 `task`、`request`），管不到 `questions` 里每一项的键；
  写错的键（例如 `multi_select`）由 pi 的校验报错，模型照报错改（临时默认值）。
- 没有 `promptSnippet`、`promptGuidelines`：说明全在 `description` 里（原文见 §14），同 memory 工具。

### 10.3 执行

1. 校验（§10.2）；不合格时返回 `isError: true` 的结果（第一行原因，第二行 `Correct form: …`，同 TaskBoard 工具的 `errorText`，`app/src/kernel/boardTools.ts:350-356`），不出卡。
2. 停止中（§10.6）或会话已关闭：直接返回停止的原文，不出卡。
3. 建请求 `ask-<n>`（每个会话从 1 起），在这个会话的信封上发 `mori.question_request { requestId, toolCallId, questions, askedAt }`，交给 away.ts 登记（§9.2），挂起直到：

| 结束方式 | `mori.question_end.by` | 工具结果 |
| --- | --- | --- |
| 你提交 | `user` | 你的答案（§10.5） |
| 你在卡上按 Esc（拒绝回答） | `declined` | 拒绝的原文 `ASK_DECLINED_TEXT`，`isError: true`（§10.6） |
| 你不在、到时 | `away` | 推荐项（§10.5、§9.4） |
| 你按了停止、`Stop team` | `stop` | 停止的原文 `ASK_STOPPED_TEXT`，`isError: true`（§10.6） |
| 会话关闭、`signal` 中止 | `closed` | 同停止 |

拒绝回答与停止用 `isError: true`：照 Claude Code 拒绝工具调用时的做法（工具结果是错误），也是界面认出它们的前提（重新打开时 `app/src/renderer/src/state/history.ts:68` 只对 `isError` 的结果认拒绝）。提交与按推荐项不是 `isError`。

- `execute(toolCallId, params, signal)` 的 `signal` 中止时按 `closed` 结束（同 `app/src/kernel/approval.ts:194`）。
- 一条回复里的多个调用按顺序执行（`toolExecution = 'sequential'`，`app/src/kernel/sessions.ts:431`），所以同一会话同一时刻至多一张提问卡。
- 工具结果的 `details`：`{ answers: AskAnswer[] | null, by }`，界面从会话文件读出已答的内容。

### 10.4 提问卡

一次调用一张卡，问题按参数的顺序列出。状态表与标识见 `docs/v1/screens/fs-question.md`。要点：

- 停在输入框上方，和扩展询问卡排在一起：同一时刻有批准卡（对话的或后台的）时先显示批准卡；提问卡与扩展询问卡按到达顺序一次显示一张，卡头 `{n} more` 计入两种（现在的 `QuestionCard.tsx` 只排扩展询问，`app/src/renderer/src/components/ChatPane.tsx:233-234`）。
- 每个问题：`header` 标签、问题原文、选项（单选为单选按钮，`multiSelect` 为勾选框），每个选项显示 `label` 与 `description`；
  推荐项在 label 后面加 ` (Recommended)`（照 Claude 的写法：label 末尾加 “(Recommended)”）；不预先选中推荐项。选项按参数的顺序显示。
- 每个问题最后多一个 `Other`：选中后出现一个输入框（照 Claude 的 Other）。单选时 Other 与选项互斥；多选时 Other 可以和选项同时选。
- 底部一个 `Submit`，每个问题都有答案（选了选项，或 Other 里有非空文字）时才可用。点了发 `question.answer`。
- 不抢输入框的焦点，没有默认按钮；在输入框里按 Enter 仍是发送、排队，不会提交（同批准卡）。
- 键盘：Tab 进卡；每个问题是一组，↑ ↓ 在组内移动，Space 选中或勾选；Tab 到下一组、Other 的输入框、Submit；Other 输入框里 Enter 在全部答完时等于 Submit；
  焦点在卡上、没有浮层时 Esc 等于拒绝回答。
- 你不在时最后 20 秒显示倒计时（§9.9）。

### 10.5 答案与工具结果

```ts
/** @brief 一个问题的答案（工具结果的 details、mori.question_end、mori.away_decision）。 */
interface AskAnswer {
  /** 问题原文 */
  question: string;
  /** 问题的 header */
  header: string;
  /** 选中的 label，按选项的顺序 */
  selected: string[];
  /** Other 里填的文字；没填为 null */
  other: string | null;
  /** 你不在、按推荐项自动回答 */
  auto: boolean;
}
```

- `question.answer { sessionId, requestId, answers }`：`answers` 按问题的顺序，每项 `{ selected: string[]; other: string | null }`；为 `null` 表示拒绝回答。
  后台进程核对：项数等于问题数；`selected` 都是这个问题的 label；单选时 `selected` 与 `other` 合起来恰好一个；多选时至少一个；`other` 去掉首尾空白后 1–2000 字符。
  不合格或请求已结束时命令失败（`Question <id> is no longer pending` / `Answers don’t match the questions.`），同 `approval.answer`。
- 一个问题的答案文字：`selected` 用 `, ` 连接，`other` 接在最后（也用 `, `）。
- 你提交时的工具结果照 Claude AskUserQuestion 的写法（外框已核实：claude-code issue #29889 引了这句；问题与答案写成 `"<问题>"="<答案>"`、用 `, ` 连接是按 Claude Code 的已知实现写的，未逐字核实）。
- 你不在时：每个问题用 `recommended`（`selected: [recommended]`、`other: null`、`auto: true`），多选也只用这一个；原文另写，说明是推荐项、不是你的选择。

### 10.6 拒绝回答、停止、关闭

| 情况 | 做法 |
| --- | --- |
| Esc（拒绝回答） | 界面发 `question.answer { answers: null }`；工具结果为 `ASK_DECLINED_TEXT`（`isError: true`）；工具卡 `Denied · You declined to answer` |
| 停止对话的回复 | `stopRun`（`app/src/kernel/sessions.ts:1109-1122`）在 `ui.beginStop()` 旁边调用 `asks.beginStop()`：挂起的提问按 `stop` 结束，工具结果为 `ASK_STOPPED_TEXT`；到 `finally` 里的 `asks.endStop()` 为止新的调用直接返回停止的原文、不出卡（同 `ExtensionUi.beginStop` / `endStop`，`app/src/kernel/extensionUi.ts:69-77`）。不用像 `rejectForStop` 那样等 2 秒：那是 `tool_call` 处理器的问题（处理器返回后 pi 先看 `signal`，`app/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:499-503`）；工具自己的 `execute` 返回什么 pi 就记什么，`signal` 已中止也一样（`agent-loop.js:568-597`） |
| `Stop team` | 同上（用户会话也被停止） |
| 会话关闭 | `release`（`app/src/kernel/sessions.ts:782-786`）里 `asks.close()`：按 `closed` 结束，之后的调用直接返回停止的原文 |
| 后台进程重启 | 挂起的提问作废；重新打开会话时那次调用没有结果，照 pi 的规则（同挂起的批准） |
| 工具卡 | 等待时 `Waiting for your answer`；提交、按推荐项为 `Done`，输出为工具结果原文；拒绝回答为 `Denied · You declined to answer`；停止、关闭为 `Stopped`（同其他工具） |
| 界面怎么认 | 实时：`mori.question_request` 把工具卡设为等待；`mori.question_end` 的 `by` 定下结果：`declined` → 已拒绝、理由 `You declined to answer`，`stop`、`closed` → 已停止；之后的 `tool_execution_end` 只记输出、不改这两种状态（同已拒绝的批准，`app/src/renderer/src/state/transcript.ts:240` 现在只保留已拒绝，要加上已停止）。重新打开：`parseRejection` 认出 `ASK_DECLINED_TEXT`；`addToolResult` 把 `ASK_STOPPED_TEXT` 与 `ABORTED_TOOL` 一样算已停止（`app/src/renderer/src/state/history.ts:41、68-70`；两者都在 §6.15 的 `DENIAL_PREFIXES` 里） |

### 10.7 协作模式分开时：把问题和答复转给立项

proposal §13 第 5 条：对话 Agent 拿到的是工具结果，立项 Agent 看不到；程序把“问题 + 你的答复”当成你的一条消息交给立项判断。

**现在**：分开时你的消息由 `UserFlow.prompt`（`app/src/kernel/teamFlow.ts:228-243`）排进“待判断”队列（`pending`，界面的排队区显示、停止时回到输入框）和立项会话的投递队列
（`team.enqueue(team.createLane(), delivery)`，`delivery.user = true`、`meta.userText`）；立项这次运行开始时按 `meta.userText` 开始一次用户消息的判断（`app/src/kernel/teamRuns.ts:62-63`），
判断完 `judgmentEnded` 把它交给对话（`app/src/kernel/teamFlow.ts:299-316`）。用户消息的投递总是单独一批（`app/src/kernel/boardRoute.ts:316-319`）。

**做法**（负责人 2026-10-26 定：只走立项会话的投递队列，不进界面上可见的待判断队列，见 §0）：

| 项 | 规则 |
| --- | --- |
| 什么时候转 | 提问结束且有答案（`user` 或 `away`），发起这次调用的那次运行的模式不是 `off`，且不是合并会话（合并会话里对话就是立项，它自己拿到了工具结果） |
| 怎么转 | `UserFlow` 新增 `forwardAnswer(text)`：建一条与用户消息同样的投递（`user: true`，文字 `deliveryText('create_user_message', { text, expanded: null })`，`cause: { kind: 'user_message' }`，`meta.userText = text`），只排进立项会话的投递队列 |
| 不做的 | 不进 `pending`：不显示在排队区、停止时不回到输入框、判断完不交给对话（`judgmentEnded` 找不到它就返回，`app/src/kernel/teamFlow.ts:300-301`），对话已经拿到答复了 |
| 立项怎么处理 | 照用户消息判断（平行 Agent 规格 §5.4）：`request_update` 记原话（不带 `quote` 时记的是这段文字，含“推荐项、不是你的选择”的说明）、`task_edit` 交回 `waiting_user` 的 task（平行 Agent 规格 §7.7 第 3 步），或不需要协作 |
| 回执 | 立项写下的回执照 `holdReceipt` 找不到这条待判断的消息时的做法，写在对话流末尾（`app/src/kernel/teamFlow.ts:279-288`） |
| `Stop team` | 立项会话投递队列里没开始的这条照现在丢弃并记日志（平行 Agent 规格 §11.4） |

### 10.8 TaskBoard 的 `ask_user`：推荐项取自交接

proposal §13 第 5 条：task 等你拿主意时，对话 Agent 也用提问卡问你，推荐项取自提出问题的 Agent 的交接。

**现在**：交接 `need_user` 时 task 变为 `waiting_user`、`question = conclusion`（`app/src/kernel/board.ts:312-315`）；立项被唤醒（`create_need_user`，`app/src/kernel/boardText.ts:1132-1137`），
它能回答就记原话交回，要问你就 `reply_via_dialog { note }`（`relay` 投递，`app/src/kernel/teamTools.ts:485-499`），都没做时程序请对话问你（`ask_user` 投递，`app/src/kernel/teamRuns.ts:475-499`、`app/src/kernel/boardText.ts:1174`）。
交接单没有放选项的字段（`app/src/kernel/handoffForm.ts:109-142`、`app/src/kernel/teamTypes.ts:77-104`）。

**交接单加两个可选字段**（task 实例与结案会话的 `task_handoff`）：

| 字段 | 规则 |
| --- | --- |
| `options` | 字符串数组，2–4 项，每项 1–60 字符、互不相同；只在 `outcome` 为 `need_user` 时可以写 |
| `recommended` | 字符串，等于 `options` 的某一项；与 `options` 一起写 |

- 校验在 `app/src/kernel/board.ts:628` 的 `handoffFieldsError` 里，不合格整次交接被拒绝（原文见 §14）。
- 记在这一棒上：`HandoffSchema` 加 `options: string[]` 与 `recommended: string | null`，两个都是 zod 的 `.optional()`：只有带选项的 `need_user` 交接才有它们。
- 强制填写（平行 Agent 规格 §7.5）：A、B 两级的严格 schema 由 `strictSchema` 自动带上这两个字段（可为 null）；`checkForm`（`app/src/kernel/handoffForm.ts:386-405`）现在只放它列出的字段，
  要加两项：读出的 `options`、`recommended` 原样放进参数（null 视为没写），规则由执行时的 `handoffFieldsError` 查；C 级的标签不加这两项（`tagFormat` 不变）。
  task 实例的强制填写一律交给结案（`app/src/kernel/board.ts:656`），带了选项也不会去问你；结案会话的强制填写写 `need_user` 时照常交给立项。

**投递里带上选项**：取这个 task 的最后一棒（`handoffs.at(-1)`：task 处在 `waiting_user` 时，它就是让 task 进入这个状态、设下 `question` 的那一棒，`app/src/kernel/board.ts:676`；
程序写的一棒没有选项，`app/src/kernel/board.ts:717`），它带 `options` 时在下面三处加一行（`ask_user`、`relay`、`create_need_user` 三种都带，负责人 2026-10-26 定，见 §0；原文见 §14）。`<角色>` 写这一棒的 `from`（结案会话为 `close:<角色>`，同 `create_need_user` 现在的 `(from …)`，`app/src/kernel/team.ts:739`）：

| 投递 | 加什么 |
| --- | --- |
| `ask_user`（task 的） | 问题之后接 `Options from <角色>: …. Recommended: …. Ask the user with ask_user_question, using these options and this recommendation.`，代替结尾的 `Ask the user.`；没有选项时原文不变 |
| `relay`（这次标了 asked 的 task 里有带选项的） | 在 note 之后每个这样的 task 一行 `For T1: options from <角色>: …. Recommended: …. Ask the user with ask_user_question, using these options and this recommendation.` |
| `create_need_user` | 问题那一行之后加 `Options from <角色>: …. Recommended: ….`；合并会话里第二行的 `ask the user in your reply` 换成 `ask the user with ask_user_question, using these options and this recommendation` |

- 对话 Agent 用提问卡问你：卡上的推荐项是交接里的 `recommended`（模型照投递写进 `recommended`；程序不改模型的参数）。你不在时按它处理。
- 你的答复按 §10.7 转给立项，立项照平行 Agent 规格 §7.7 第 3 步交回 task。需求级问题（`Request N`）没有交接，投递不变。

### 10.9 扩展的确认、选择、输入

pi 的 `confirm`、`select`、`input` 没有推荐项字段（`dist/core/extensions/types.d.ts:40-45、72-78`），你不在时按取消处理（proposal §13 第 6 条，§9.4），与现在扩展自己的超时结果相同（`app/src/kernel/extensionUi.ts:110-111`）。
扩展自己带了 `timeout` 时两个计时各管各的，先到的生效；卡上 `This request expires in N seconds` 照旧，你不在时另有倒计时一行。
