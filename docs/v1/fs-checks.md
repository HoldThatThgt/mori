# 文件系统 检查记录

依据：[构建规格](../specs/file-system.md)（§0–§5、§11–§19）与 [续篇](../specs/file-system-permissions.md)（§6–§10），下称“规格”；
它们实现 [文件系统 Proposal](../proposals/file-system.md) 第一版（2026-10-26）。在 `claude/happy-bell-a93948` 分支上做（从 `app-v0` 的 8004ddd 切出），
按 proposal §11 第 3 条分三步提交：权限（§6–§10）→ git（§3–§5）→ 并行（§11 与 §8 的 `limits`）。

## 状态

进行中。本节在每一步提交时更新。

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

## 交互细节照 Claude 桌面版

规格与屏幕表没写、实现时照 Claude 桌面版定的（第 1 步）：

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
