# 推送前的完整回归（2026-10-26，wt/cov-integration）

负责人要求推送，按 AGENTS.md“测试分层”第 3 条在开发构建上跑完整回归。分支 `wt/cov-integration`，起点 `c4cebd0`
（app-v0 + 三个功能 + 八个覆盖分支 + 清理）。每组一节：命令、通过 / 失败 / KNOWN 的个数、秒数，失败的根因与修正的提交。
套件一次只跑一个（每次启动 Mori 都弹窗口）。真实层（`*-real`）、录制（`*-record`）、预检和测量脚本不在这里跑。

## 这一轮的环境

- 负责人不在，会话处于锁屏状态：`LogonUI.exe` 在运行，WTS 的会话标记是锁定。这时 Windows 拒绝所有进程打开系统剪贴板
  （PowerShell `Set-Clipboard` 报 "Requested Clipboard operation did not succeed."，`OpenClipboard` 返回拒绝访问），
  与 Mori 无关；同 [docs/v0/english-ui-checks.md](../../v0/english-ui-checks.md) 第二轮记的情形。
- 同一时间另一个会话在别处跑了一次 `npm run test:quick`（不是这一组起的进程，没有动它）；另有一个上午 9:31 起、属于
  `wt-wp15-pi-catalog` 的 Playwright 启动的 Electron（PID 21716，父进程已不在），也不是这一组起的，留着没动。

## m0–m2 组

开发构建：`npx electron-vite build`（`npm run test:quick` 自己也会先构建）。这一组没有改 `src/`，只改了测试。

| 命令 | 结果（通过 / 失败 / KNOWN） | 秒 | 说明 |
| --- | --- | --- | --- |
| `npm run test:quick`（第一遍） | 4/4 项通过：m0-smoke 41、tb-replay `--only tb-team` 19、mem-replay `--only mem-tool` 17、m1-replay `--only readme` 16 | 81（含构建 96） | |
| `node tests/ui/m0-shell.mjs` | 8 / 0 / 0 | 11 | 情形 A、B 都跑了（这台机器的注册表里有 Git for Windows 的 InstallPath） |
| `node tests/ui/m1-app.mjs`（第一遍） | 53 / 1 / 0 | 136 | 失败 1：“复制代码”，见下 |
| `node tests/ui/m1-layout.mjs` | 没有检查（退出码 0） | 0 | 只是帮助模块（导出量法和检查，没有顶层的流程），它的检查在 m1-app、m1-replay 里跑 |
| `node tests/ui/m1-replay.mjs`（第一遍） | 138 / 1 / 0 | 196 | 失败 1：`expand：展开前对话流滚在中间…`，见下 |
| `node tests/ui/m2-app.mjs` | 104 / 0 / 0 | 124 | |
| `node tests/ui/m2-replay.mjs` | 110 / 0 / 0 | 48 | |
| `node tests/ui/m1-app.mjs`（修正后整套） | 53 / 0 / 1 | 132 | KNOWN 1：锁屏时的“复制代码” |
| `node tests/ui/m1-replay.mjs`（修正后整套，第一次） | 138 / 1 / 0 | 201 | expand 通过；新的失败 1：`steps-history：点开被切开的组…`，见下 |
| `node tests/ui/m1-replay.mjs`（修正后整套，第二、三次） | 139 / 0 / 0，两次相同 | 197、197 | 第三次是为了在 `--only` 之后留下整套的结果文件 |
| `npm run test:quick`（修正后） | 4/4 项通过（同上） | 81（含构建 96） | |
| `npm run check`、`npm run test:unit` | 通过；497/497 | 5（单元） | |

最后留下的结果文件：`test-results/m0-shell.json`、`m1-app.json`、`m1-replay.json`、`m2-app.json`、`m2-replay.json`
都是整套跑的。

### 失败与修正

1. **`m1-app` “代码块：点"复制代码"后代码进系统剪贴板”**（detail 为空）。
   - 根因：环境。会话锁屏，系统剪贴板谁都打不开：测试经主进程 `clipboard.writeText` 写进去的“剪贴板原来的内容”读回来
     也是空串。`--only copyCode` 重跑同样失败；同一时间 PowerShell 写剪贴板同样失败。今天早些时候（没锁屏时）别的工作树
     （`wt-wp01-firstrun`、`wt-wp12-context`）里这项是通过的。
   - 修正（`d9826d0`）：`tests/ui/lib.mjs` 新加 `clipboardBlocked(app, text)`：经主进程写进一段文字再读回；读不回且
     `LogonUI.exe` 在运行时记 KNOWN（这台机器此时造不出的环境，detail 写明写进去的、读回的和锁屏状态），读不回却没锁屏
     时照样记失败，读得回时断言与原来相同（剪贴板里留着这段文字，当作“原来的内容”）。U42 记在负责人决定的登记里。
   - 重跑：`m1-app --only copyCode` 记 KNOWN（"system clipboard unusable: wrote "剪贴板原来的内容", read back "";
     LogonUI running (session locked): true"），整套 53 / 0 / 1。
   - **没有验证**：Mori 的“Copy code”真的把代码写进系统剪贴板，这一轮在锁屏下验证不了；解锁后跑
     `node tests/ui/m1-app.mjs --only copyCode` 应为 PASS。`m4-app` 的“复制”“复制路径”在锁屏下会遇到同样的情形
     （m3–m4 那一组的事，`clipboardBlocked` 可以照用）。

2. **`m1-replay --only layout` “expand：展开前对话流滚在中间、展开了一张工具卡；"Expand"再"Collapse"后滚动位置和这张卡的
   展开状态都在”**（`index: -1`：视野里没有整张的工具卡）。WP-13 补测时加的、写着“集成时跑”，这是第一次在这条分支上跑。
   - 根因：测试的帮助函数。`synthetic-long-history` 重新打开后只载入了最近的一部分（14 个步骤组）。`page.mjs` 的
     `expandSteps`（`clickRows`）先数一次折起的行再点那么多次；点最上面一行时 Playwright 把它滚进视野、对话流到顶，
     载入了更早的 16 组（新的组都折着），剩下的点击用完了，16 组没展开。中间那段的卡都在折着的组里，正好滚到一半时视野里
     只有正文。
   - 修正（`d228614`）：`clickRows` 每点一次都重新数，直到没有那种状态的行；每点一行都等它的 `aria-expanded` 翻过来
     （点了不变时 5 秒超时报错，不会一直点下去）。检查改为把离可滚高度一半最近的那张看得见的卡居中，再取视野里整张的第一张卡；
     断言另加“不在底部”（`before.top < before.room - 1`），原来的条件都不变。
   - 重跑：`m1-replay --only layout` 23/23；用到 `expandSteps` / `foldSteps` 的另两处也用 `--only` 跑了：
     `tb-replay --only tb-team,tb-receipts` 27/27（结果写 `tb-partial-replay.json`），`v1-models-replay --only switch-mid`
     9/9（这个套件 `--only` 照样写整套的 `v1-models-replay.json`，后面跑 v1-models 的那一组整套跑时会重写）。

3. **`m1-replay` “steps-history：点开被切开的组（展开后滚得动）再滚到顶部载入更早的：组接长成"60 steps"…”**（修正后第一次
   整套时出现，第一遍整套与 `--only` 都通过；失败时仍是 "49 steps"、没有你的消息）。
   - 根因：测试的时序。点开组之后，对话流在 ResizeObserver 里跟到底部（`Transcript.tsx` `useFollow`）。测试随即设
     `scrollTop = 0`：如果这时还没跟到底部，`scrollTop` 本来就是 0，没有 scroll 事件；或者同一帧里 ResizeObserver 又把它
     跟回底部，scroll 事件看到的是底部。两种情形都不会触发载入更早的（`useLoadEarlier` 只在离顶部不超过 40px 时载入）。
   - 修正（`cd4ed36`）：滚到顶部之前逐帧（`polling: 'raf'`）等对话流停在底部、离顶部超过 `TOP_SLACK`（40px）且相邻两帧的
     高度不变，再设 `scrollTop = 0`；断言不变。
   - 重跑：最后的写法 `m1-replay --only steps-history` 跑了 3 次都是 5/5（只等“停在底部”的前一版另跑了 7 次，也都通过）；
     整套又跑了两次，都是 139 / 0 / 0。

### 这一组没有做的

- `m1-app` 的“复制代码”在锁屏下只能记 KNOWN，见上面第 1 条；解锁后要重跑那一步。
- 调查时有一次命令里的变量没生效，一份调试日志写到了 `D:\Git\m1-replay-shd.log`（Git Bash 的根目录）。删除它被安全检查
  拦下，留给负责人删除；里面只有 `--only steps-history` 的 5 行通过结果。

## m3–m5 组

开发构建：`npx electron-vite build`（16 秒）。这一组没有改 `src/`，只改了测试（`tests/ui/lib.mjs`、`m3-app-live.mjs`、
`m4-app.mjs`、`m5-app.mjs`），所以没有重新构建（`npm run test:quick` 自己又构建了一次）。环境同上：会话仍锁屏
（`LogonUI.exe` 在运行）；另一个会话 9:30 起的 `tests/ui/quick.mjs`（PID 17628，停在 m0-smoke）和 PID 21716 的 Electron
还在，都不是这一组起的，没有动。这一组起的进程都随套件退出了（跑完查过没有留下的 node / electron，4324、4325、4335 端口
没有人在听）。

| 命令 | 结果（通过 / 失败 / KNOWN） | 秒 | 说明 |
| --- | --- | --- | --- |
| `node tests/ui/m3-app.mjs`（第一遍，含 m3-app-live 的步骤） | 174 / 1 / 0 | 144 | 失败 1：步骤组“扩展的询问挂着时……没有摘要行”，见下 |
| `node tests/ui/m3-replay.mjs` | 63 / 0 / 0 | 34 | |
| `node tests/ui/m4-app.mjs`（第一遍） | 98 / 8 / 0 | 131 | 失败 8：都是读系统剪贴板的检查，见下 |
| `node tests/ui/m4-replay.mjs` | 27 / 0 / 0 | 33 | |
| `node tests/ui/m5-app.mjs`（第一遍） | 63 / 1 / 0 | 125 | 失败 1：`splitRightMax` 的“没有另外的 800px 上限”，见下 |
| `node tests/ui/m5-replay.mjs` | 26 / 0 / 0 | 140 | |
| `node tests/ui/m3-app.mjs --only buildTree,extOpen,extCloseWindow,extAnswer`（修正后） | 21 / 0 / 0 | 16 | |
| `node tests/ui/m4-app.mjs --only changes,viewerStates,previewOpens,copyPath,replyMarkdown,replyActions`（修正后） | 23 / 3 / 8 | 62 | KNOWN 8 是锁屏时的剪贴板；失败 3 是这次选的步骤少了前提（见下第 2 条），整套里都通过 |
| `node tests/ui/m5-app.mjs --only singleExpand,menuSplit,splitRightMax,splitExpand`（修正后） | 12 / 0 / 0 | 13 | WP-13.md 写的那组步骤 |
| `node tests/ui/m4-app.mjs`（修正后整套） | 98 / 0 / 8 | 132 | KNOWN 8：锁屏时的剪贴板 |
| `node tests/ui/m5-app.mjs`（修正后整套） | 64 / 0 / 0 | 125 | |
| `node tests/ui/m3-app.mjs`（修正后整套） | 175 / 0 / 0 | 143 | |
| `npm run check`、`npm run test:unit` | 通过；497/497 | 5（单元） | |
| `npm run test:quick`（修正后） | 4/4 项通过：tb-replay 19、m0-smoke 41、mem-replay 17、m1-replay 16 | 80（含构建 95） | |

最后留下的结果文件：`test-results/m3-app.json`、`m3-replay.json`、`m4-app.json`、`m4-replay.json`、`m5-app.json`、
`m5-replay.json` 都是整套跑的。

### 失败与修正

1. **`m3-app`（m3-app-live 的 `extAnswer`）“步骤组：扩展的询问挂着时（project_ask 的卡 Running…）这一组在进行中，没有摘要行，
   那张卡看得见”**（`{"rows":1,"status":"running","visible":true,"title":"project_ask"}`）。
   - 根因：两个覆盖分支合在一起后测试的前提不成立。cov-tray（`a69639e`）在 `extAnswer` 前面加了 `extCloseWindow`：它在同一个
     会话 E1 里跑完一轮 `project_once`，这一轮结束后它的组照 chat.md“步骤组”折成一行“1 step”，是对的。cov-taskmode
     （`1b325a8`）加的 `askCardShown` 用 `stepsState` 数整个对话流里的摘要行，要求是 0，写的时候 E1 前面还没有结束的那一轮。
     状态表“进行中”一行要的是这一组没有摘要行，不是整个对话流没有。
   - 修正（`f4e82f4`）：断言那张 Running 的卡在一个组里（外层有 `data-step-group`）、这个组没有摘要行（没有 `data-group`
     等于它的行）、最后一条你的消息之后没有摘要行；前面几轮的行数只写进 detail（`earlier`）。卡的状态、看得见照旧断言。
   - 重跑：`--only buildTree,extOpen,extCloseWindow,extAnswer` 通过（detail `"group":"i6:1","turnRows":0,"groupRows":0,
     "earlier":1`，正好是 `project_once` 那一轮的行）；整套 175 / 0 / 0。

2. **`m4-app` 读系统剪贴板的 8 条**：“复制路径：路径是按钮……约 2 秒后消失”、“复制路径：显示源码时……role="status"”、
   “复制路径："File not found"时也能复制”、“……"Preview unavailable · Binary file"时也能复制”、“……读取失败、路径已解析
   出来时（文件被占用）……”、“……路径解析不出（file:// 地址里有编码的斜杠）……”、“mermaid 图：回复下的"Copy"复制的仍是
   Markdown 原文……”、“复制：这一轮的正文进系统剪贴板，按钮短暂显示"已复制"”。剪贴板读回的都是空串。
   - 根因：环境，同 m0–m2 组第 1 条（会话锁屏，Windows 不让任何进程打开剪贴板）。剪贴板以外的条件都成立：路径按钮的读屏名、
     读取中不可用、“Path copied to clipboard.”出现又消失、role="status"、各状态的文字、mermaid 画成了图、按钮变成“Copied”。
   - 修正（`ba77a62`）：`tests/ui/lib.mjs` 新加 `recordClipboard(record, name, { rest, clip, blocked }, detail)`。每条检查在
     复制前用 `clipboardBlocked` 写进一段文字再读回（同时清掉上一次复制的结果；原来“File not found”等三条复制前不清），
     剪贴板以外的条件 `rest` 照常断言，只有剪贴板的条件不成立、而且 LogonUI 在运行时记 KNOWN，没锁屏时照样记失败（U42 的
     做法）。检查名不变（WP-13.md 的表引用它们）。`copyFailure`（换掉 `clipboard.writeText` 让它抛错）不读剪贴板，没改。
   - 重跑：上面那次 `--only` 里 8 条都是 KNOWN；另外 3 条失败（“copyPath：流程”等 `docs/run.bat` 的卡、“回复下的操作：
     每轮一行……”、“走查 5：……引用到输入框”）是这次选的步骤少了前提：`docs/run.bat` 是 `openExternal` 写的，回复下的操作
     那几条数的是整套前面各步留下的轮次。整套重跑 98 / 0 / 8，这 3 条都通过。
   - **没有验证**：这 8 条里剪贴板的内容（复制的是完整路径、工具参数里的原文、Markdown 原文、这一轮的正文）在锁屏下验证不了；
     解锁后跑整套 `node tests/ui/m4-app.mjs`（132 秒）应为 106 / 0 / 0。

3. **`m5-app` `splitRightMax`“分屏放得下（1600 宽）时右栏没有另外的 800px 上限：分隔线拖到底时上限是"窗口 − 左栏 − 560"
   （大于 800），右栏就这么宽，两栏各 280px”**（`{"width":1600,"panel":780,"sidebar":260,"now":780,"max":780,…,"slots":[280,280]}`）。
   - 根因：测试的期望。这是 WP-13 补测（`878c943`）新加、写着“集成时跑”的用例，这是第一次跑。窗口 1600 宽时左栏的默认宽度是
     260px（layout.md“分隔线”：窗口宽 ≤1150 时 220px，否则 260px；`state/layout.ts` `defaultWidth`），上限
     1600 − 260 − 560 = 780，小于 800，这条永远不会通过；写的时候是按 220px 的左栏算的（1600 − 220 − 560 = 820）。
     界面本身是对的：上限确实是“窗口 − 左栏 − 560”，右栏也拖到了上限，两栏各 280px。
   - 修正（`bcb234a`）：这一步在窗口 1600 宽时先用左栏分隔线的 ← 把左栏调到 220px（每次 20px，等分隔线的 `aria-valuenow`
     变成 220），量完再用 → 调回原来的宽度（前面的步骤已经存过布局，存下的值不变）。断言一条没改。另一种办法是把窗口开到
     1700 宽，要改检查名、WP-13.md 的表，也要看这台机器的屏幕放不放得下，没有用。
   - 重跑：`--only singleExpand,menuSplit,splitRightMax,splitExpand` 12 / 0 / 0（`"panel":820,"sidebar":220,"max":820`）；
     整套 64 / 0 / 0（后面各步不受左栏调过的影响）。

### 这一组没有做的

- `m4-app` 的 8 条剪贴板检查在锁屏下只能记 KNOWN，见上面第 2 条；解锁后要重跑整套 `m4-app`。

## m6 组

开发构建：`npx electron-vite build`（16 秒）；改了 `src/kernel` 之后又构建了一次（`npm run test:m6-app`、`npm run test:quick`
自己也先构建）。环境同上：会话仍锁屏（`LogonUI.exe` 在运行）；PID 21716、17628、1736 和占着 4399 端口的 36088 都不是这一组起的，
没有动。这一组起的进程都随套件退出了（跑完查过没有留下的 node / electron，4361–4366、4936 端口没有人在听）。

| 命令 | 结果（通过 / 失败 / KNOWN） | 秒 | 说明 |
| --- | --- | --- | --- |
| `node tests/ui/m6-app-settings.mjs`（第一遍） | 89 / 1 / 0 | 58 | 失败 1：`agentsKernelExit` 的“Restart 后重新读取失败……项目一栏不显示”，见下第 1 条 |
| `node tests/ui/m6-app-settings.mjs --only agentsUser,agentsKernelExit`（调查） | 28 / 0 / 0 | 12 | 同一条检查只在 `--only` 时通过 |
| 同上（修正的第一版） | 26 / 1 / 0 | 43 | 收尾时点不到原来的会话，见下第 1 条，改掉了 |
| 同上（修正后） | 28 / 0 / 0 | 12 | |
| `node tests/ui/m6-app-settings.mjs`（修正后整套） | 90 / 0 / 0 | 59 | |
| `node tests/ui/m6-app-tools.mjs` | 144 / 0 / 0 | 36 | |
| `node tests/ui/m6-app-slash.mjs`（含 m6-app-bands 的步骤） | 106 / 0 / 0 | 101 | |
| `node tests/ui/m6-app-row.mjs` | 50 / 0 / 0 | 87 | |
| `node tests/ui/m6-app-mcp-shared.mjs` | 49 / 0 / 0 | 79 | |
| `node tests/ui/m6-app-bands.mjs` | 没有检查（退出码 0） | 1 | 只是帮助模块：它的步骤由 m6-app-slash 按原来的顺序执行、记进 m6-app-slash 的结果（文件头写明） |
| `node tests/ui/m6-app-tool-switches.mjs`（第一遍） | 15 / 2 / 0 | 86 | 失败 2：`reopen：流程`、`projectOverride：流程`，见下第 2 条 |
| `node tests/ui/m6-app-tool-switches.mjs --only reopen,projectOverride`（只修了信任框） | 4 / 2 / 0 | 11 | 失败 2：`reopen` 的两条检查，见下第 2 条 |
| 同上（改了 `src/kernel` 之后） | 6 / 0 / 0 | 12 | |
| `node tests/ui/m6-app-tool-switches.mjs`（修正后整套） | 19 / 0 / 0 | 30 | |
| `node tests/ui/m6-replay.mjs`（`src` 改动之后的构建） | 71 / 0 / 0 | 42 | |
| `npm run test:m6-app`（`src` 改动之后，整条命令：构建加五个套件） | 439 / 0 / 0（90 + 144 + 106 + 50 + 49） | 377 | |
| `npm run check`、`npm run test:unit` | 通过；499/499 | 5（单元） | 单元多了 `reopenedTools` 的两条 |
| `npm run test:quick`（`src` 改动之后） | 4/4 项通过：tb-replay 19、m0-smoke 41（另 1 KNOWN：pi #9129，上游）、mem-replay 17、m1-replay 16 | 93（含构建 109） | |
| `node tests/ui/m3-app.mjs`（`src` 改动之后） | 175 / 0 / 0 | 146 | m3–m5 组的套件：改的 `refreshTools` 也是 m3-app“信任之后重新打开不信任时保存的会话”走的路，重跑确认 |
| `node tests/ui/m1-replay.mjs`（整套） | 139 / 0 / 0 | 206 | 只为留下整套的结果文件：`npm run test:quick` 里的 `m1-replay --only readme` 把 `test-results/m1-replay.json` 换成了 16 条的 |

不在这里跑的 m6 脚本（读过文件头）：`m6-pi-config.mjs`（录 `fixtures/m6/pi-config-toggles.json` 的脚本，`--check` 是 pi 升级时
用的）、`m6-mcp-cost.mjs`（测量内存与进程）、`m6-real.mjs`（真实层）、`m6-record.mjs`（录制）；`m6-helpers.mjs`、
`m6-tools-helpers.mjs` 是帮助模块。

最后留下的结果文件：`test-results/m6-app-settings.json`、`m6-app-tools.json`、`m6-app-slash.json`、`m6-app-row.json`、
`m6-app-mcp-shared.json`（`npm run test:m6-app` 写的）、`m6-app-tool-switches.json`、`m6-replay.json`，以及重跑的
`m3-app.json`、`m1-replay.json`，都是整套跑的。

### 失败与修正

1. **`m6-app-settings`（`agentsKernelExit` 的 `exitRereadFailure`）“Restart 后重新读取失败（<agentDir>\AGENTS.md 是一个文件夹）：
   顶部"Couldn’t load AGENTS.md: "加原文，读到过的内容、编辑框和草稿还在；没读到这个会话的项目文件，项目一栏不显示（不是
   "Loading…"）”**（`{"title":"Files loaded by m6proj"}`：项目一栏还在）。
   - 根因：测试的前提只在 `--only` 时成立。WP-07 加这条检查时只用 `--only` 跑过（WP-07.md：`m6-app-settings.mjs` 没有整套
     连着跑过），那时 Customize 跟随的会话是 `agentsUser` 里 Ctrl+N 建的、没有消息：`Restart` 后 `reopen`（`projects.ts`）找不到
     会话文件就新建，pi 会话 id 换了，Restart 之前读到的列表不是它的，项目一栏不显示。整套跑时跟随的是 S1，前面的步骤在它里面
     发过消息：`Restart` 后从会话文件打开、pi 会话 id 不变，`AgentsSection` 按 `readFor === sessionId` 认出读到过它的列表，
     重新读取失败时留着，正是状态表“重新读取失败”一行的“项目一栏读到过跟随的会话的列表时留着”（与留着读到过的用户级内容
     一致）。界面没有错。按推荐定为 U43（照现在的界面）。
   - 修正（`b908a8d`）：`exitRereadFailure` 先离开 Customize、Ctrl+N 新建一个没有消息的会话、再进 Instructions 跟随它
     （`followFresh`），整套与 `--only` 都是“没读到这个会话的项目文件”的情形；断言另加这个会话 `Restart` 后确实是新建的（回到会话
     面板后它的会话文件换了，detail 的 `recreated`），原来的条件一条没改。最后留在这个会话的面板里，后面的步骤各自点开要用的会话
     （`narrowRow` 点 S1，`reopen` 重启 Mori）。修正的第一版在收尾时发一条消息、归档这个会话、再点回原来的会话：`--only` 时原来的
     会话同样没有消息、`Restart` 后会话文件换了，点不到（上表 26 / 1），所以改成现在的做法。
   - 重跑：`--only agentsUser,agentsKernelExit` 28 / 0 / 0（`"title":null,"recreated":true`）；整套 90 / 0 / 0；
     `npm run test:m6-app` 里同样 90 / 0 / 0。

2. **`m6-app-tool-switches` 的 `reopen：流程`（`page.waitForFunction: Timeout 30000ms exceeded`）与 `projectOverride：流程`
   （点不到“Open folder…”）**。这两步是 WP-08 补的、写着“集成时跑”（WP-08.md），这是第一次跑。
   - 第一个原因：测试。`reopen` 关掉 Mori 再启动，点项目 main 的会话、等它就绪；`setup` 信任 main 时没有勾“Remember my choice”，
     按 sessions.md“已回答”只在那一次运行里算数，重启后打开前又问“Trust this workspace?”（截图 `reopen-error.png`），等就绪超时；
     `projectOverride` 的“Open folder…”被这个对话框挡着，同样超时。修正：`reopen` 改用 `openTrusted`，点开后在对话框里选
     “Trust workspace”（照 `makeLayout` 写的“打开时都选 Trust workspace”），再等就绪。
   - 第二个原因：产品。之后 `reopen` 的两条检查失败：重启后重新打开的旧会话里 ls、grep、find 仍是“Not enabled”（开关开着），
     调用 grep、find 得到 “Tool grep not found”。tools.md“按了开关”写“之后新建的会话（含重启后重新打开的会话）里它是
     Enabled”（WP-08 替负责人定的第 1 条，理由写的是“pi 在建会话时选默认工具”）；实际上 pi 1.3.0 打开有记录的会话时按记录恢复
     当时启用的工具（`agent-session.js` `_restoreToolsFromTranscript`），不看现在的 `defaultTools`，Mori 的 `refreshTools` 原来只补
     扩展的工具。按推荐定为 U44（照状态表改 Mori）。修正（`04d55b2`）：`defaultTools.ts` 新加 `reopenedTools`：从会话文件打开
     用户会话时，内置工具换成现在的设置选出的（`getDefaultTools() ?? read、bash、edit、write`，同 pi 建新会话；开和关都算，换了时
     排在前面），别的工具照恢复的留着，再补扩展的工具；和恢复的是同一组工具时不重设、顺序不动。`sessions.ts` `refreshTools` 用它。
     单元测试两条（`tests/unit/defaultTools.test.mjs`），docs/v0/defaults.md 登记“重新打开的会话的内置工具”。Task mode 的对话照旧
     在每轮开始前按模式重设工具，不受影响。
   - 重跑：`--only reopen,projectOverride` 6 / 0 / 0（grep、find 的失败卡是 pi 的原文 “ripgrep (rg) is not available and could not be
     downloaded”“fd is not available and could not be downloaded”）；整套 19 / 0 / 0。`src` 改了，又跑了 `m6-replay`、
     `npm run test:m6-app`、`npm run test:quick` 和 `m3-app`（`refreshTools` 的另一路：信任后重新打开不信任时保存的会话，
     `["read","bash","edit","write","memory","subagent","project_hello"]` 与原来相同），都通过。

### 这一组没有做的

- **没有验证**：U44 改了发给模型的东西（重新打开的会话的内置工具和现在的设置不同时，发给模型的工具、system prompt 的工具清单
  与规则随之变）。没有录 fixture：没有回放用例回放重新打开的会话的工具（`m6-replay` 的 `tool-switch` 回放的是新会话）。没有跑
  真实模型：真实层不在这一组跑；给重新打开的会话改启用的工具走的是 `refreshTools` 原来补扩展工具的同一条路（m3-real 走查 5 用
  真实模型走过“打开时补上工具，下一次请求前 pi 把它声明给模型”），新会话里打开 ls 由 `m6-real --only t` 走过。要不要补跑一次
  真实模型（例如在重新打开的旧会话里调用 ls），由 lead 定。
- `m6-app-tool-switches` 第一遍失败时按设计留下了临时目录 `C:\Users\blue\AppData\Local\Temp\mori-m6-switches-neNQZU`（通过时会删），
  没有删。

## 模型层组（`npm run test:v1-models`）

开发构建：`npx electron-vite build`（16 秒），提交 `1a32d8a`（含 m6 组改了 `src/kernel` 的 `04d55b2`）。这一组没有改 `src/`，也没有
改测试，只加了这一节。`npm run test:v1-models` 是一串 `&&`：`npm run test:unit`、构建、五个 `v1-models-app-*` 套件、
`v1-models-replay`、`v1-models-existing`（默认的 MP-37）、`node tests/spec-coverage.mjs`（模型层，不带 `--allow-missing-real`）。
这里照同样的顺序、同样的参数一项一项跑：整条命令在一项失败时就停，`v1-models-app-switch` 一项又要近 10 分钟。
环境：开始时会话仍锁屏（`LogonUI.exe` 在运行）；22:02 再查时已经解锁（LogonUI 不在，剪贴板读得出），见下面“解锁后重跑”。
PID 21716、17628、1736 和占着 4399 端口的 36088 都不是这一组起的，没有动。这一组起的进程都随套件退出了（跑完查过没有留下的
node / electron，4300–4999 端口只有 36088 的 4399 在听）。各套件按设计留下自己打印的临时数据目录（`mori-v1s-*`、
`mori-v1-switch-*` 等），没有删。

| 命令 | 结果（通过 / 失败 / KNOWN） | 秒 | 说明 |
| --- | --- | --- | --- |
| `npm run test:unit` | 499/499 | 5 | 写 `v1-unit.json` |
| `npx electron-vite build` | 通过 | 16 | |
| `node tests/ui/v1-models-app-settings.mjs` | 145 / 0 / 0 | 112 | |
| `node tests/ui/v1-models-app-reorder.mjs` | 28 / 0 / 0 | 30 | |
| `node tests/ui/v1-models-app-switch.mjs` | 77 / 0 / 0 | 595 | 结果未知、排队超时、候选耗尽按 §12 的真实时长跑 |
| `node tests/ui/v1-models-app-session.mjs` | 148 / 0 / 0 | 240 | |
| `node tests/ui/v1-models-app-nooff.mjs` | 37 / 0 / 0 | 40 | |
| `node tests/ui/v1-models-replay.mjs` | 42 / 0 / 0 | 82 | 整套跑，换掉了 m0–m2 组 `--only switch-mid` 留下的结果文件 |
| `node tests/ui/v1-models-existing.mjs`（MP-37） | App 11 / 0 / 0，回放 6 / 0 / 0 | 1575 | 每个套件一条，见下表 |
| `node tests/spec-coverage.mjs` | 失败：缺口 2（MP-27、MP-40 的真实层） | 0 | 见下面“这一组没有做的”第 1 条 |
| `node tests/spec-coverage.mjs --allow-missing-real` | 通过（真实层记 pending） | 0 | 其余 38 个编号在列出的每一层都有通过的结果 |
| `node tests/ui/m1-app.mjs --only copyCode`（解锁后） | 11 / 0 / 0 | 15 | “复制代码”通过 |
| `node tests/ui/m1-app.mjs`（解锁后整套） | 54 / 0 / 0 | 136 | |
| `node tests/ui/m4-app.mjs`（解锁后整套） | 106 / 0 / 0 | 130 | 8 条剪贴板检查都通过 |

`v1-models-existing`（MP-37）里各套件的结果（套件自己打印的 PASS / KNOWN 行；每条按退出码记通过，日志在
`test-results/v1-models-existing/<套件>.log`）：

| 套件 | 通过 / 失败 / KNOWN | 秒 | 说明 |
| --- | --- | --- | --- |
| m0-smoke | 41 / 0 / 1 | 44 | KNOWN：命令超时后留下 sleep 进程（pi #9129，上游） |
| m1-app | 53 / 0 / 1 | 132 | KNOWN：锁屏时的“复制代码”（m0–m2 组第 1 条） |
| m2-app | 104 / 0 / 0 | 124 | |
| m3-app | 175 / 0 / 0 | 144 | |
| m4-app | 98 / 0 / 8 | 132 | KNOWN 8：锁屏时的剪贴板（m3–m5 组第 2 条） |
| m5-app | 64 / 0 / 0 | 125 | |
| m6-app-settings | 90 / 0 / 0 | 58 | |
| m6-app-tools | 144 / 0 / 0 | 38 | |
| m6-app-slash | 106 / 0 / 0 | 102 | |
| m6-app-row | 50 / 0 / 0 | 88 | |
| m6-app-mcp-shared | 49 / 0 / 0 | 80 | |
| m1-replay | 139 / 0 / 0 | 200 | |
| m2-replay | 110 / 0 / 0 | 49 | |
| m3-replay | 63 / 0 / 0 | 36 | |
| m4-replay | 27 / 0 / 0 | 35 | |
| m5-replay | 26 / 0 / 0 | 144 | |
| m6-replay | 71 / 0 / 0 | 43 | |

最后留下的结果文件：`test-results/v1-unit.json`、`v1-models-app-settings.json`、`v1-models-app-reorder.json`、
`v1-models-app-switch.json`、`v1-models-app-session.json`、`v1-models-app-nooff.json`、`v1-models-replay.json`、
`v1-models-app-existing.json`、`v1-models-replay-existing.json`，以及 MP-37 重写的 m0–m6 各套件的结果文件，都是整套跑的；
`m1-app.json`、`m4-app.json` 是解锁后整套跑的那一次。

### 失败与修正

套件里没有失败的检查，这一组没有提交修正。唯一的失败是覆盖检查的两个缺口：

1. **`node tests/spec-coverage.mjs`“MP-27 Real: no passing check”“MP-40 Real: no passing check”**（退出码 1，
   `real (no result file for Real)`）。
   - 根因：这个工作树里没有真实层的结果文件 `test-results/v1-models-real.json`（`test-results/` 在 `.gitignore` 里，工作树建好后
     没有人在这里跑过 `v1-models-real.mjs`）。MP-27、MP-40 在 §14.2 里只列真实层，结果只能由真实模型走查产生。不是测试或产品的
     错误，也不是上游或这台机器造不出的环境，所以没有记 KNOWN。
   - 没有修：要修只能跑真实层（见下面“这一组没有做的”第 1 条），这一轮的回归不跑真实层（本文开头），AGENTS.md“测试分层”第 5 条
     也只在模型看到的或做的有变化时跑。带 `--allow-missing-real` 时覆盖检查通过：其余 38 个编号的单元、App、回放层都有通过的结果，
     没有失败的检查，也没有前缀是 MP、编号却不在表里的检查。

### 解锁后重跑

会话 22:02 前后解锁，趁这时把前两组留下的“解锁后要重跑”做了：`m1-app --only copyCode` 通过（读回的是代码块的原文
`export function add(a: number, b: number): number { return a + b; }`），整套 54 / 0 / 0；`m4-app` 整套 106 / 0 / 0，复制路径
（六种状态）、mermaid 回复的“Copy”、这一轮正文的“Copy”这 8 条剪贴板检查都通过。m0–m2 组第 1 条、m3–m5 组第 2 条记的
**没有验证**因此已经验证。MP-37 那一次里的 m1-app、m4-app 仍是锁屏时跑的（KNOWN 照记，按退出码记通过），没有为此重跑整个
MP-37。

### 这一组没有做的

1. **模型层的真实层（MP-27、MP-40）没有跑**，所以 `npm run test:v1-models` 的最后一步（不带 `--allow-missing-real` 的覆盖检查）
   不通过。要补的话在这个工作树的 `app/` 下（先构建）跑
   `node tests/ui/v1-models-real.mjs --source C:\Users\blue\AppData\Local\Temp\mori-real-data`，
   再跑 `node tests/spec-coverage.mjs`。
   它用负责人的 key 对 DeepSeek、GLM 和 OpenRouter 的免费模型发真实请求（免费模型每天有请求上限，与 `md-real.mjs` 同一天跑时
   要注意，§14.1）。跑不跑、推送前是否接受 `--allow-missing-real`，由 lead 定。

## TaskBoard 组（`npm run test:taskboard`）

开发构建：`npx electron-vite build`（18 秒），提交 `a211f0f`（含 m6 组的 `04d55b2`）；改了 `src/` 之后（`1161548`）再构建，
后面的重跑都在新构建上。`npm run test:taskboard` 是一串 `&&`：`test:tb-unit`、构建、`tb-build-base`、十一个 `tb-app-*`
（含 `tb-app-tasks`、`tb-app-tasks-owner`）、`tb-replay`、`v1-models-existing --id TB-46`、`spec-coverage --spec taskboard`
（不带 `--allow-missing-real`）。这里照同样的顺序、同样的参数一项一项跑（一项失败时整条命令就停）。
环境：会话没有锁屏（开始时、结束时 `LogonUI.exe` 都不在）。PID 21716（和它的子进程 10752、36856，`wt-wp15-pi-catalog` 上午
9:31 起的）、占着 4399 端口的 36088 都不是这一组起的，没有动；这一组起的进程都随套件退出了（跑完查过）。
`tb-app-tasks-owner` 照设计把负责人 `%APPDATA%\Mori` 里的一个会话文件和 teams 目录拷进临时数据目录，只读。

| 命令 | 结果（通过 / 失败 / KNOWN） | 秒 | 说明 |
| --- | --- | --- | --- |
| `npm run test:tb-unit` | 379/379 | 7 | 写 `tb-unit.json` |
| `npx electron-vite build` | 通过 | 18 | |
| `node tests/ui/tb-build-base.mjs` | 通过（把 2e67197 建进 `.tb-runs/base`） | 10 | TB-03 的对照构建；不打印 PASS 行 |
| `node tests/ui/tb-app-roles.mjs`（第一遍） | 52 / 1 / 0 | 130 | 失败 1：TB-09 关闭模式 `tools: [read]` 的工具集合，见下面第 1 条 |
| `node tests/ui/tb-app-modes.mjs` | 83 / 0 / 0 | 271 | |
| `node tests/ui/tb-app-flow.mjs` | 45 / 0 / 0 | 135 | |
| `node tests/ui/tb-app-ask.mjs` | 35 / 0 / 0 | 248 | |
| `node tests/ui/tb-app-handoff.mjs` | 55 / 0 / 0 | 163 | |
| `node tests/ui/tb-app-sched.mjs` | 24 / 0 / 0 | 135 | |
| `node tests/ui/tb-app-models.mjs` | 40 / 0 / 0 | 210 | |
| `node tests/ui/tb-app-stop.mjs`（第一遍） | 50 / 2 / 0 | 183 | 失败 2：TB-54 窄栏的两条焦点检查，见下面第 2 条 |
| `node tests/ui/tb-app-misc.mjs` | 20 / 0 / 0 | 150 | |
| `node tests/ui/tb-app-tasks.mjs` | 98 / 0 / 0 | 246 | |
| `node tests/ui/tb-app-tasks-owner.mjs` | 5 / 0 / 0 | 28 | TB-88：负责人的 T1–T6 与结案会话都打开，T4（约 1 MB）210 ms；没有发出模型请求 |
| `node tests/ui/tb-replay.mjs`（第一遍） | 71 / 0 / 0 | 84 | |
| `node tests/ui/v1-models-existing.mjs --id TB-46` | App 14 / 0 / 0，回放 9 / 0 / 0 | 2639 | 每个套件一条，见下表；同时写 MP-37 的两个结果文件 |
| `node tests/ui/tb-app-stop.mjs --only row`（加了诊断，没有提交） | 5 / 2 / 0 | 35 | 记下焦点事件的顺序，查根因用，见第 2 条 |
| `node tests/ui/tb-app-stop.mjs --only row`（修正后） | 7 / 0 / 0 | 30 | 两条 TB-54 通过 |
| `node tests/ui/tb-app-roles.mjs --only readOnlyDialog`（修正后） | 4 / 0 / 0 | 26 | TB-09 两条通过 |
| `npm run check`、`npm run test:unit` | 通过；499/499 | 5（单元） | |
| `npm run test:quick`（修正后） | 4/4 项通过：tb-replay `--only tb-team` 35、m0-smoke 48、mem-replay `--only mem-tool` 25、m1-replay `--only readme` 25 | 85（含构建 103） | |
| `node tests/ui/tb-app-stop.mjs`（修正后整套） | 52 / 0 / 0 | 178 | |
| `node tests/ui/tb-app-roles.mjs`（修正后整套） | 53 / 0 / 0 | 131 | |
| `node tests/ui/tb-app-flow.mjs`（修正后整套） | 45 / 0 / 0 | 136 | 这几个套件都有 Stop agents，`useHiddenFallback` 改了之后重跑 |
| `node tests/ui/tb-app-models.mjs`（修正后整套） | 40 / 0 / 0 | 210 | 同上 |
| `node tests/ui/tb-app-modes.mjs`（修正后整套） | 83 / 0 / 0 | 271 | 同上 |
| `node tests/ui/tb-app-tasks.mjs`（修正后整套） | 98 / 0 / 0 | 245 | 同上 |
| `node tests/ui/tb-replay.mjs`（修正后整套） | 71 / 0 / 0 | 83 | 界面回放也用 `rowMenu.ts` |
| `node tests/spec-coverage.mjs --spec taskboard` | 失败：缺口 7（TB-04、TB-08、TB-34、TB-37、TB-45、TB-59、TB-89 的真实层） | 0 | 见下面“这一组没有做的”第 1 条 |
| `node tests/spec-coverage.mjs --spec taskboard --allow-missing-real` | 通过（真实层记 pending） | 0 | 其余各编号在列出的每一层都有通过的结果，没有失败的检查，也没有前缀是 TB、编号却不在表里的检查 |
| `node tests/ui/m1-replay.mjs`（整套） | 139 / 0 / 0 | 203 | `test:quick` 把 `m1-replay.json` 换成了 16 条的部分结果，重跑整套换回来 |

`v1-models-existing --id TB-46` 里各套件的结果（套件自己打印的 PASS / KNOWN 行；每条按退出码记通过，日志在
`test-results/tb-existing/<套件>.log`）。它在 `src/` 改动之前跑：这些套件都不进协作模式、没有 Stop agents，
`useHiddenFallback` 的新监听只在有 Stop agents 时装上，所以没有为修正重跑。

| 套件 | 通过 / 失败 / KNOWN | 秒 | 说明 |
| --- | --- | --- | --- |
| m0-smoke | 41 / 0 / 1 | 46 | KNOWN：命令超时后留下 sleep 进程（pi #9129，上游） |
| m1-app | 54 / 0 / 0 | 134 | 没锁屏，“复制代码”通过 |
| m2-app | 104 / 0 / 0 | 127 | |
| m3-app | 175 / 0 / 0 | 146 | |
| m4-app | 106 / 0 / 0 | 131 | 8 条剪贴板检查都通过 |
| m5-app | 64 / 0 / 0 | 127 | |
| m6-app-settings | 90 / 0 / 0 | 61 | |
| m6-app-tools | 144 / 0 / 0 | 38 | |
| m6-app-slash | 106 / 0 / 0 | 102 | |
| m6-app-row | 50 / 0 / 0 | 88 | |
| m6-app-mcp-shared | 49 / 0 / 0 | 84 | |
| v1-models-app-settings | 145 / 0 / 0 | 115 | |
| v1-models-app-switch | 77 / 0 / 0 | 598 | |
| v1-models-app-session | 148 / 0 / 0 | 244 | |
| test:unit | 499 / 0 / 0 | 5 | |
| m1-replay | 139 / 0 / 0 | 201 | |
| m2-replay | 110 / 0 / 0 | 49 | |
| m3-replay | 63 / 0 / 0 | 36 | |
| m4-replay | 27 / 0 / 0 | 34 | |
| m5-replay | 26 / 0 / 0 | 143 | |
| m6-replay | 71 / 0 / 0 | 45 | |
| v1-models-replay | 42 / 0 / 0 | 84 | |
| spec-coverage（模型层，`--allow-missing-real`） | 通过 | 0 | |

最后留下的结果文件：`test-results/tb-unit.json`、全部 `tb-app-*.json`、`tb-replay.json`、`tb-app-existing.json`、
`tb-replay-existing.json`（以及 TB-46 重写的 MP-37 两个文件和 m0–m6、`v1-models-app-settings`、`-switch`、`-session`、
`v1-models-replay` 的结果文件）都是整套跑的；`tb-app-roles.json`、`tb-app-stop.json`、`tb-app-flow.json`、`tb-app-models.json`、
`tb-app-modes.json`、`tb-app-tasks.json`、`tb-replay.json` 是修正后整套跑的那一次，`m1-replay.json` 是最后整套跑的那一次。
`--only` 写的是 `tb-partial-*.json`，覆盖检查不算。

### 失败与修正

1. **`tb-app-roles` “TB-09 off mode with chat.md "tools: [read]": every dialog request has only read, agent_message and memory”**
   （四次请求的工具都是 `["agent_message","memory","read","subagent"]`）。
   - 根因：测试的期望过时。subagent 工具合进来以后，关闭模式的对话持有者总有 `subagent`，不受角色 `tools` 限制
     （subagent 规格 §2“对话持有者是基座还是写了 `tools` 的角色”、SA-01“对话持有者写了 `tools: [read]` 时也有”；TaskBoard 规格
     §5.2“设成角色的工具（加 `subagent`…）”）。同一文件里协作模式切回关闭的那条 TB-09 已经改成带 `subagent`，这一条漏了。
     产品是对的。
   - 修正（`abd5b8b`）：期望的集合改为 `agent_message`、`memory`、`read`、`subagent`，仍比整组（多一个、少一个都不过），
     另一条“调用 bash、edit、write 被拒绝、文件不变”不变；检查名写明 subagent。TB-09 那一行的说明加一条 2026-10-26 注
     （照 §5.2 与 SA-01，不是新行为）。
   - 重跑：`--only readOnlyDialog` 4 / 0 / 0，整套 53 / 0 / 0。

2. **`tb-app-stop` 两条 TB-54：“with Stop agents shown, a pane narrowed from 600px to 520px folds "Queue" while it has the focus:
   the focus goes back to the text box”（`{"onQueue":true,"back":false}`）与“… the "Queue ▾" menu open … narrowing the pane from
   400px to 340px folds the group away: the menu closes and the focus goes back to the text box”（`{"opened":true,"inMenu":true,
   "gone":true,"back":false}`）**。覆盖补测（`1b325a8`）新加、写着“集成时跑”，这是第一次跑。
   - 根因：产品。models.md“窄栏”的“有 Stop agents、≤ 520px”“最窄”两档要焦点回到文字框。`rowMenu.ts` 的 `useHiddenFallback`
     只在 ResizeObserver 的回调里看 `document.activeElement`；而 Chromium 的焦点修正先把藏起（`display: none`）的按钮的焦点
     移到 body，回调轮到时焦点已经在 body 上，`node.contains(body)` 不成立，什么都不做。在测试里临时加了监听（没有提交）记下
     顺序：600→520px 时先 `focusout`（目标 `queue-main`，`relatedTarget` 为 null，此时 `activeElement` 已是 BODY），之后
     ResizeObserver 才回调（看到 BODY）；400→340px 时同样，目标是下拉里的 `queue-later`。第二条里下拉关上了（root 自己藏起时
     回调照样关），只是焦点留在 body。拖分隔线、改窗口时只要先有一次强制排版（量宽度等），都是这个顺序。
   - 修正（`1161548`，`app/src/renderer/src/components/rowMenu.ts`）：`useHiddenFallback` 另在 root 上听 `focusout`：焦点没有移到
     别的元素上（`relatedTarget` 为 null）、失去焦点的元素已经藏起时，root 也藏起就先关下拉，再 `focusComposer`（浮层还开着时
     它等浮层关上）。点空白处失去焦点时元素还看得见，不动；栏被藏起（换了标签页）时 `focusComposer` 找不到看得见的文字框，
     也不动。原来的 ResizeObserver 检查留着（回调先到时照旧）。v0 defaults.md 那一行补上这一句（`f4c08c8`）。
   - 重跑：`--only row` 7 / 0 / 0（`{"onQueue":true,"back":true}`、`{"opened":true,"inMenu":true,"gone":true,"back":true}`），
     整套 52 / 0 / 0；有 Stop agents 的 `tb-app-flow`、`-models`、`-modes`、`-tasks` 和 `tb-replay` 整套重跑都通过（上表）。

### 这一组没有做的

1. **TaskBoard 的真实层（TB-04、TB-08、TB-34、TB-37、TB-45、TB-59、TB-89）没有跑**，所以 `npm run test:taskboard` 的最后一步
   （不带 `--allow-missing-real` 的覆盖检查）不通过：这个工作树里没有 `test-results/tb-real.json`（`test-results/` 在
   `.gitignore` 里）。不是测试或产品的错误，也不是上游或这台机器造不出的环境，没有记 KNOWN。这一轮的回归不跑真实层（本文开头），
   AGENTS.md“测试分层”第 5 条也只在模型看到的或做的有变化时跑；这一组的两处修正一处只改测试、一处只改界面的焦点，发给模型的
   都没有变。要补的话在这个工作树的 `app/` 下先 `node tests/ui/tb-build.mjs real`，再跑
   `MORI_APP_DIR=.tb-runs/real node tests/ui/tb-real.mjs --source C:\Users\blue\AppData\Local\Temp\mori-real-data`，
   最后 `node tests/spec-coverage.mjs --spec taskboard`。它用负责人的 key 发真实请求。跑不跑、推送前是否接受
   `--allow-missing-real`，由 lead 定（同模型层组第 1 条）。
2. **没有验证**：真实桌面上用鼠标拖分隔线让栏变窄时的焦点（测试里改的是窗口大小，焦点事件的顺序相同；真实的拖动没有在这台机器上看）。

## 记忆组（`npm run test:memory`）

开发构建：`npx electron-vite build`（17 秒），提交 `e251ff6`（含 m6 组的 `04d55b2` 与 TaskBoard 组的 `1161548`）。这一组没有改 `src/`，
只改了测试（`27d87c7`、`5039944`），没有为它们重新构建。`npm run test:memory` 是一串 `&&`：`test:mem-unit`、构建、七个 `mem-app-*`、
`mem-replay`、`v1-models-existing --id MEM-35`、`spec-coverage --spec memory --allow-missing-real`。这里照同样的顺序、同样的参数一项一项
跑（第一项失败时整条命令会停，这里接着跑完了后面各项）。
环境：会话没有锁屏（开始时、结束时 `LogonUI.exe` 都不在），剪贴板检查（MEM-35 里的 `m1-app`、`m4-app`）都通过。PID 21716（和它的子进程
10752、36856）、占着 4399 端口的 36088 都不是这一组起的，没有动；这一组起的进程都随套件退出了（跑完查过，没有比这一组开始更晚的
node / electron 进程）。`tb-app-tasks-owner` 照设计把负责人 `%APPDATA%\Mori` 里的一个会话文件和 teams 目录拷进临时数据目录，只读。

| 命令 | 结果（通过 / 失败 / KNOWN） | 秒 | 说明 |
| --- | --- | --- | --- |
| `npm run test:mem-unit` | 239/239 | 14 | 写 `mem-unit.json` |
| `npx electron-vite build` | 通过 | 17 | |
| `node tests/ui/mem-app-prompt.mjs`（第一遍） | 48 / 1 / 0 | 100 | 失败 1：M12 分开配置的工具页，见下面第 1 条 |
| `node tests/ui/mem-app-tool.mjs` | 59 / 0 / 0 | 145 | |
| `node tests/ui/mem-app-page.mjs` | 112 / 0 / 0 | 96 | |
| `node tests/ui/mem-app-enhance-a.mjs` | 83 / 0 / 0 | 106 | |
| `node tests/ui/mem-app-enhance-b.mjs` | 32 / 0 / 0 | 288 | |
| `node tests/ui/mem-app-team.mjs` | 50 / 0 / 0 | 57 | |
| `node tests/ui/mem-app-settings.mjs` | 85 / 0 / 0 | 59 | |
| `node tests/ui/mem-replay.mjs` | 65 / 0 / 0 | 50 | |
| `node tests/ui/v1-models-existing.mjs --id MEM-35` | App 24 / 0 / 0，回放 12 / 0 / 0 | 4329 | 每项一条，见下表；同时写 MP-37、TB-46 的结果文件。跑的时候列表里还没有 `tb-app-tasks`、`tb-app-tasks-owner`，见第 2 条 |
| `node tests/ui/mem-app-prompt.mjs --only split`（修正后） | 17 / 0 / 0 | 36 | M12 两条都通过 |
| `node tests/ui/v1-models-existing.mjs --id MEM-35 --only tb-app-tasks,tb-app-tasks-owner`（修正后） | App 2 / 0 / 0 | 273 | `tb-app-tasks` 98 / 0 / 0（245 秒）、`tb-app-tasks-owner` 5 / 0 / 0（28 秒）；写 `mem-partial-existing-app.json` |
| `node tests/ui/mem-app-prompt.mjs`（修正后整套） | 49 / 0 / 0 | 100 | |
| `node tests/spec-coverage.mjs --spec memory --allow-missing-real` | 通过（真实层记 pending） | 0 | 各编号在列出的每一层都有通过的结果；没有失败的检查，也没有前缀是 MEM、编号却不在表里的检查 |
| `node tests/spec-coverage.mjs --spec memory` | 失败：缺口 4（MEM-05、MEM-10、MEM-22、MEM-34 的真实层） | 0 | 见下面“这一组没有做的”第 1 条 |
| `npm run check`、`npm run test:unit` | 通过；499/499 | 5（单元） | 两处修改之后都跑过 |
| `npm run test:quick`（修正后） | 4/4 项通过：tb-replay `--only tb-team` 35、m0-smoke 47、mem-replay `--only mem-tool` 25、m1-replay `--only readme` 25 | 84（含构建 101） | |
| `node tests/ui/m1-replay.mjs`（整套） | 139 / 0 / 0 | 200 | `test:quick` 把 `m1-replay.json` 换成了 16 条的部分结果，重跑整套换回来 |

`v1-models-existing --id MEM-35` 里各项的结果（套件自己打印的 PASS / KNOWN 行；每项按退出码记通过，日志在
`test-results/mem-existing/<套件>.log`）。m0-smoke 那一行汇总写的 “1 FAIL” 是它的 KNOWN 行（汇总把 FAIL 与 KNOWN 行一起数），退出码 0。

| 套件 | 通过 / 失败 / KNOWN | 秒 | 说明 |
| --- | --- | --- | --- |
| m0-smoke | 41 / 0 / 1 | 46 | KNOWN：命令超时后留下 sleep 进程（pi #9129，上游） |
| m1-app | 54 / 0 / 0 | 133 | 没锁屏，“复制代码”通过 |
| m2-app | 104 / 0 / 0 | 128 | |
| m3-app | 175 / 0 / 0 | 145 | |
| m4-app | 106 / 0 / 0 | 129 | 8 条剪贴板检查都通过 |
| m5-app | 64 / 0 / 0 | 127 | |
| m6-app-settings | 90 / 0 / 0 | 59 | |
| m6-app-tools | 144 / 0 / 0 | 37 | |
| m6-app-slash | 106 / 0 / 0 | 102 | |
| m6-app-row | 50 / 0 / 0 | 88 | |
| m6-app-mcp-shared | 49 / 0 / 0 | 82 | |
| v1-models-app-settings | 145 / 0 / 0 | 115 | |
| v1-models-app-switch | 77 / 0 / 0 | 597 | |
| v1-models-app-session | 148 / 0 / 0 | 243 | |
| tb-build-base | 通过（没有重建：`.tb-runs/base` 已在） | 0 | |
| tb-app-roles | 53 / 0 / 0 | 130 | |
| tb-app-modes | 83 / 0 / 0 | 270 | |
| tb-app-flow | 45 / 0 / 0 | 136 | |
| tb-app-ask | 35 / 0 / 0 | 248 | |
| tb-app-handoff | 55 / 0 / 0 | 163 | |
| tb-app-sched | 24 / 0 / 0 | 135 | |
| tb-app-models | 40 / 0 / 0 | 210 | |
| tb-app-stop | 52 / 0 / 0 | 178 | |
| tb-app-misc | 20 / 0 / 0 | 149 | |
| test:unit | 499 / 0 / 0 | 5 | |
| test:tb-unit | 379 / 0 / 0 | 7 | |
| m1-replay | 139 / 0 / 0 | 199 | |
| m2-replay | 110 / 0 / 0 | 49 | |
| m3-replay | 63 / 0 / 0 | 36 | |
| m4-replay | 27 / 0 / 0 | 35 | |
| m5-replay | 26 / 0 / 0 | 141 | |
| m6-replay | 71 / 0 / 0 | 43 | |
| v1-models-replay | 42 / 0 / 0 | 83 | |
| tb-replay | 71 / 0 / 0 | 81 | |
| spec-coverage（模型层，`--allow-missing-real`） | 通过 | 0 | 也记作 TB-46 的 “spec-coverage” |
| spec-coverage-taskboard（`--allow-missing-real`） | 通过 | 0 | 用这次写的 `tb-app-existing.json`、`tb-replay-existing.json` |

最后留下的结果文件：`test-results/mem-unit.json`、全部 `mem-app-*.json`、`mem-replay.json`、`mem-app-existing.json`（24 项）、
`mem-replay-existing.json`（12 项）都是整套跑的；`mem-app-prompt.json` 是修正后整套跑的那一次。MEM-35 这一次还重写了 MP-37
（`v1-models-app-existing.json`、`v1-models-replay-existing.json`）、TB-46（`tb-app-existing.json`、`tb-replay-existing.json`）的结果文件
与其中每个套件自己的结果文件；`m1-replay.json` 是最后整套跑的那一次。`--only` 写的是 `mem-partial-*.json`，覆盖检查不算。

### 失败与修正

1. **`mem-app-prompt` “M12 Customize › Built-in tools of a split-config user session lists exactly the three TaskBoard tools
   board_read, read_session and agent_message (source "Mori", no switch, "Mori turns this on and off with Task mode." under
   each), before and after Task mode is turned on”**（三次都读到 `["board_read","read_session","agent_message","subagent"]`）。
   - 根因：测试的期望过时。用例把来源为 `Mori`、名字不是 `memory` 的行都当成 TaskBoard 工具；subagent 合进来以后，用户会话总注册
     `subagent`（`mori-team` 在会话载入时注册，subagent 规格 §2），它在工具页也是来源 `Mori` 的一行，但有自己的原因
     `Mori turns this on when Task mode is off.`（tools.md“不是 pi 内置工具的行”；subagent 规格 §2 写明“不能归进 TaskBoard 工具
     那一类”）。产品是对的：同一套件里 “M12 "Enabled" on the Tools page …” 那条通过，`subagent` 关闭模式时 Enabled、
     协作模式那一轮之后 Not enabled，与请求的 tools 一致。
   - 修正（`27d87c7`，`app/tests/ui/mem-app-prompt.mjs`）：取 TaskBoard 行时按名字去掉 `memory` 与 `subagent`（`NOT_BOARD`），
     其余来源 `Mori` 的行照旧都算进来；仍与那 3 个整组比较（多出任何 TaskBoard 工具、少一个都不过），每行没有开关、原因是
     Task mode 那一句的断言不变。
   - 重跑：`--only split` 17 / 0 / 0，整套 49 / 0 / 0。
2. **MEM-35 少跑了两个套件**（不是失败的检查，跑完对照规格时发现）。记忆规格 §14.4 写 MEM-35 的 App 层跑 `tb-app-*`，
   `v1-models-existing.mjs` 的 `TB_APP_SUITES` 注释也写“与 npm 脚本 test:taskboard 的顺序相同”，列表却只到 `tb-app-misc`。
   - 根因：Background tasks 合进来时 `test:taskboard` 加了 `tb-app-tasks`、`tb-app-tasks-owner`，这张列表没跟上。MEM-35 记的
     “通过”因此少了这两个套件（MD-15 经 `MEMORY_LISTS` 同样少）。
   - 修正（`5039944`，`app/tests/ui/v1-models-existing.mjs`）：两个套件按 `test:taskboard` 的顺序加在 `tb-app-misc` 后面。
     规格的 `tb-app-*` 写的时候还没有这两个，按推荐算进去，U45 记在负责人决定的登记里。
   - 重跑：`--id MEM-35 --only tb-app-tasks,tb-app-tasks-owner` 两项都通过（98 / 0 / 0、5 / 0 / 0）。整套的
     `mem-app-existing.json`（24 项）是修正之前跑的，没有这两项；它们的结果在 `mem-partial-existing-app.json`（覆盖检查不算）。
     MEM-35 的 App 层在覆盖检查里照样有通过的结果；下一次整套跑 MEM-35（或 MD-15，它另写 MEM-35 的结果文件）时就是 26 项。

### 这一组没有做的

1. **记忆的真实层（MEM-05、MEM-10、MEM-22、MEM-34）没有跑**，所以不带 `--allow-missing-real` 的覆盖检查不通过：这个工作树里
   没有 `test-results/mem-real.json`（`test-results/` 在 `.gitignore` 里）。不是测试或产品的错误，也不是上游或这台机器造不出的
   环境，没有记 KNOWN。`npm run test:memory` 自己的最后一步带 `--allow-missing-real`，通过。这一轮的回归不跑真实层（本文开头），
   这一组的两处修正都只改测试，发给模型的没有变。要补的话在这个工作树的 `app/` 下跑
   `node tests/ui/mem-real.mjs --source C:\Users\blue\AppData\Local\Temp\mori-real-data`，再跑 `node tests/spec-coverage.mjs --spec memory`；
   它用负责人的 key 发真实请求。U39 推荐的 `mem-real --only dialog` 由 lead 定什么时候跑（同模型层组、TaskBoard 组第 1 条）。
2. **整套 MEM-35 没有在 `5039944` 之后重跑**（约 75 分钟）：加进来的两个套件用 `--only` 在预设里跑过、都通过，其余 24 项的结果
   不受这次修改影响（只加了列表项）。要让 `mem-app-existing.json` 本身是 26 项，推送前再整套跑一次
   `node tests/ui/v1-models-existing.mjs --id MEM-35`（或跑 MD-15）。

## subagent 与 Customize › Agents 组（`npm run test:subagent`、`npm run test:agents`）

开发构建：`npx electron-vite build`（两条命令前各一次，17 秒、17 秒），提交 `3cc471e`（含 m6 组的 `04d55b2` 与 TaskBoard 组的
`1161548`）。这一组没有改 `src/`，也没有改测试。两条命令都是一串 `&&`，这里照同样的顺序、同样的参数一项一项跑：
`test:subagent` 是 `test:sa-unit`、构建、`sa-app`、`sa-replay`、`spec-coverage --spec subagent`（不带 `--allow-missing-real`）；
`test:agents` 是 `test:ag-unit`、构建、`ag-app`、`v1-models-existing --id AG-11`、`spec-coverage --spec agents`。
`sa-app` 照 npm 脚本在 `out/` 的构建上跑（文件头写的 `MORI_APP_DIR=.tb-runs/sa` 是单独跑时的用法，npm 脚本不带）。
环境：会话没有锁屏（开始时、结束时 `LogonUI.exe` 都不在）。开始时在跑的 PID 21716（和它的子进程 10752、36856）、17628
（另一个会话 9:30 起的 `test:quick`）与它的子进程 1736、占着 4399 端口的 36088 都不是这一组起的，没有动；这一组起的进程都随套件
退出了（跑完查过，没有 2:00 之后起的 node / electron 进程）。

| 命令 | 结果（通过 / 失败 / KNOWN） | 秒 | 说明 |
| --- | --- | --- | --- |
| `npm run test:sa-unit` | 29/29 | 4 | 写 `sa-unit.json` |
| `npx electron-vite build` | 通过 | 17 | |
| `node tests/ui/sa-app.mjs` | 48 / 0 / 0 | 208 | 十步（normal、parallel、queued、slots、approval、stop、reload、kill、edits、roles）都跑了 |
| `node tests/ui/sa-replay.mjs` | 16 / 0 / 0 | 23 | `sa-subagent` 录制的重启前、重启后，m1 的两个录制（SA-17） |
| `node tests/spec-coverage.mjs --spec subagent` | 失败：缺口 4（SA-04、SA-05、SA-12、SA-16 的真实层） | 0 | 见下面“这一组没有做的”第 1 条 |
| `node tests/spec-coverage.mjs --spec subagent --allow-missing-real` | 通过（真实层记 pending） | 0 | 其余各编号在列出的每一层都有通过的结果；没有失败的检查，也没有前缀是 SA、编号却不在表里的检查 |
| `npm run test:ag-unit` | 42/42 | 2 | 写 `ag-unit.json` |
| `npx electron-vite build` | 通过 | 17 | |
| `node tests/ui/ag-app.mjs` | 62 / 0 / 0 | 51 | |
| `node tests/ui/v1-models-existing.mjs --id AG-11` | App 6 / 0 / 0，回放 1 / 0 / 0 | 541 | 每项一条，见下表 |
| `node tests/spec-coverage.mjs --spec agents` | 通过 | 0 | AG-01–AG-11 在列出的每一层（单元、App）都有通过的结果；这份规格没有真实层 |

`v1-models-existing --id AG-11` 里各项的结果（套件自己打印的 PASS / FAIL / KNOWN 行；每项按退出码记通过，日志在
`test-results/ag-existing/<套件>.log`）：

| 套件 | 通过 / 失败 / KNOWN | 秒 | 说明 |
| --- | --- | --- | --- |
| tb-build-base | 通过（没有重建：`.tb-runs/base` 已在） | 0 | |
| tb-app-roles | 53 / 0 / 0 | 130 | |
| tb-app-models | 40 / 0 / 0 | 211 | TB-38 的菜单项多了 `Manage agents` |
| m6-app-tools | 144 / 0 / 0 | 37 | |
| m6-app-settings | 90 / 0 / 0 | 60 | |
| mem-app-settings | 85 / 0 / 0 | 59 | |
| m6-replay | 71 / 0 / 0 | 44 | 记进 `ag-replay-existing.json` |

最后留下的结果文件：`test-results/sa-unit.json`、`sa-app.json`、`sa-replay.json`、`ag-unit.json`、`ag-app.json`、
`ag-app-existing.json`（6 项）、`ag-replay-existing.json`（1 项）都是整套跑的；AG-11 跑的每个套件也重写了自己的结果文件
（`tb-app-roles.json`、`tb-app-models.json`、`m6-app-tools.json`、`m6-app-settings.json`、`mem-app-settings.json`、
`m6-replay.json`），都是整套跑、都通过的。

### 失败与修正

套件里没有失败的检查，这一组没有提交修正。唯一的失败是 subagent 覆盖检查的四个缺口：

1. **`node tests/spec-coverage.mjs --spec subagent`“SA-04 / SA-05 / SA-12 / SA-16 Real: no passing check”**（退出码 1，
   `real (no result file for Real)`）。
   - 根因：这个工作树里没有真实层的结果文件 `test-results/sa-real.json`（`test-results/` 在 `.gitignore` 里，工作树建好后没有人
     在这里跑过 `sa-real.mjs`）。SA-04、SA-05、SA-12 在 §14.3 里列了真实层，SA-16 只列真实层，结果只能由真实模型走查产生。
     不是测试或产品的错误，也不是上游或这台机器造不出的环境，所以没有记 KNOWN。
   - 没有修：要修只能跑真实层（见下面“这一组没有做的”第 1 条）。带 `--allow-missing-real` 时覆盖检查通过。

### 这一组没有做的

1. **subagent 的真实层（SA-04、SA-05、SA-12、SA-16）没有跑**，所以 `npm run test:subagent` 的最后一步（不带
   `--allow-missing-real` 的覆盖检查）不通过。这一轮的回归不跑真实层（本文开头），这一组没有任何修改，发给模型的没有变
   （AGENTS.md“测试分层”第 5 条）。要补的话在这个工作树的 `app/` 下先 `node tests/ui/tb-build.mjs sa`，再跑
   `MORI_APP_DIR=.tb-runs/sa node tests/ui/sa-real.mjs --source C:\Users\blue\AppData\Local\Temp\mori-real-data`，
   最后 `node tests/spec-coverage.mjs --spec subagent`。它用负责人的 key 对 DeepSeek 与 GLM 发真实请求。跑不跑、推送前是否接受
   `--allow-missing-real`，由 lead 定（同模型层组、TaskBoard 组、记忆组第 1 条）。
2. SA-17 的推送前条件（`npm run test:taskboard`、`npm run test:memory` 的整套与覆盖检查通过，§14.2）由 TaskBoard 组、记忆组
   跑：两组的套件都通过；TaskBoard 不带 `--allow-missing-real` 的覆盖检查因同样的真实层缺口不通过（TaskBoard 组第 1 条）。

## 真实模型组（测试分层第 5 条：U35、U39 与 subagent 说明的改动）

本文开头说真实层不在这里跑；这一组是例外：这一轮模型看到的有变化（U35：WP-09 改过的 m3-real 走查 2、m6-real 走查 8 的检查；
U39：memory 与 subagent 工具的说明、两句投递的撇号），按 U35、U39 只跑覆盖这些变化的五个驱动。都在这个工作树的 `app/` 下、
都带 `--source C:\Users\blue\AppData\Local\Temp\mori-real-data`：脚本把数据目录复制到临时目录（只复制加密的文件，不读 key，
不写来源目录，跑完删掉副本里的 `credentials.json`）。模型是负责人的 DeepSeek（`mori-endpoint/deepseek-flash`）与 GLM
（`glm/GLM-5.3`）。

开发构建：`npx electron-vite build`（17 秒），提交 `d6c59ca`；`tb-real` 与 `sa-real` 照文件头先 `node tests/ui/tb-build.mjs real`、
`node tests/ui/tb-build.mjs sa`（两个共 34 秒），再分别带 `MORI_APP_DIR=.tb-runs/real`、`MORI_APP_DIR=.tb-runs/sa` 跑；`m3-real`、
`m6-real`、`mem-real` 用 `out/`。这一组没有改 `src/`，只改了两个真实层脚本，所以没有重新构建。
环境：会话没有锁屏（开始时、结束时 `LogonUI.exe` 都不在）。这台机器的 shell 带 `TZ=America/Los_Angeles`（Windows 是东部时间），
所以 Mori 的后台进程写的时刻（例如 `can’t connect until 23:35:07`）比任务栏的时钟早 3 小时，是环境，与 Mori 无关。PID 21716（和
它的子进程 10752、36856）、17628、1736、占着 4399 端口的 36088 都不是这一组起的，没有动；这一组起的进程都随脚本退出了（跑完查过，
没有 2:25 之后起的 node / electron 进程，4300–4999 端口只有 36088 的 4399 在听）。

| 命令 | 结果（通过 / 失败 / KNOWN） | 秒 | 说明 |
| --- | --- | --- | --- |
| `node tests/ui/m3-real.mjs --source … --only 2` | 10 / 0 / 0 | 11 | 走查 2：Ctrl+N、Shift+Tab 回到会话树、Shift+F10 改名、改名后发第一条消息名字不变 |
| `node tests/ui/m6-real.mjs --source … --only 8` | 11 / 0 / 0 | 17 | 走查 8：Supports thinking、新会话默认 Low、生成中 Effort 不可用、High 有思考（鸡兔同笼）、Off 没有思考、分屏右栏换 GLM-5.3 |
| `MORI_APP_DIR=.tb-runs/real node tests/ui/tb-real.mjs --source … --only approval`（第一遍） | 9 / 1 / 0 | 41 | 失败 1：TB-37 核对 0 行 running，见下第 1 条 |
| `node tests/ui/mem-real.mjs --source … --only dialog` | 14 / 0 / 0 | 51 | 四句话都用 memory 记下（fact、rule 给了 `asked: true`），条目、索引、修订与依据都对，不要批准，View in Memory 打开那一条 |
| `MORI_APP_DIR=.tb-runs/sa node tests/ui/sa-real.mjs --source … --only read`（第一遍） | 2 / 2 / 0 | 146 | 失败 2：两个模型各 3 次都“没有调用 subagent”，见下第 2 条 |
| `npm run check` | 通过 | — | 两处修改之后各跑一次 |
| 同上 `sa-real --only read`（修正后） | 12 / 0 / 0 | 68 | 两个模型都分成 3 个只读 subagent、都 done；只读请求只有 `read`、`ls`；三个同时跑；结果按 §6.3 |
| 同上 `tb-real --only approval`（修正后） | 10 / 0 / 0 | 43 | 这次 TB-37 核对了 3 行 running；两张后台批准卡都写明 `executor · T1 · …` |
| `npm run test:unit` | 499/499 | 5 | |
| `npm run test:quick`（修正后） | 4/4 项通过：tb-replay `--only tb-team` 34、m0-smoke 46、mem-replay `--only mem-tool` 24、m1-replay `--only readme` 25 | 84（含构建 100） | |
| `node tests/ui/m1-replay.mjs`（整套） | 139 / 0 / 0 | 198 | `test:quick` 把 `m1-replay.json` 换成了 16 条的部分结果，重跑整套换回来 |

留下的结果文件：`test-results/m3-real.json`、`m6-real.json`（这两个脚本 `--only` 时照样写这个名字，内容只有这一项走查）；
`tb-partial-real.json`、`mem-partial-real.json`、`sa-partial-real.json`（`--only`，覆盖检查不算）；`m1-replay.json` 是整套跑的。
截图在 `test-results/m3-real/`、`m6-real/`、`tb-real/`、`mem-real/`、`sa-real/`。

### 失败与修正

1. **`tb-real --only approval` “TB-37 real approval: the progress summary's request and task titles equal the titles in board.json,
   and each running task row shows the §13.8 title of that instance session's latest tool call (0 running rows checked)”**
   （`{"problems":[],"rows":["Request 1 · Run node --version and report the version · With Mori · <1 min","… · Done · <1 min"]}`）。
   - 根因：模型的做法，产品照状态表。合并会话（基座持有对话、立项与结案）里 DeepSeek 在 `request_submit`、`task_create` 之后没有结束
     那一段，接着调 `board_read`、`board_read`、`read_session`、`board_read`、`reply_via_dialog`，一直等到 T1 做完（会话文件：executor
     的实例 06:28:39 停、结案 06:28:42 关闭 T1，`mori.progress` 06:28:44 才写）。team-stream.md“位置”一节：进展摘要要等登记它的那一段
     结束（`mori.progress`）才显示，之前只有回执。所以摘要出现时 T1 已经结束，折叠时不列已结束的 task，界面上从来没有 running 行；
     标题都对（problems 为空）。检查要求“核对过的 running 行 > 0”，这一条取决于模型什么时候结束那一段，§17.1 写的模型怎么做只进 note。
   - 修正（`39c69c6`，`app/tests/ui/tb-real.mjs` `progressChecks`、`tb-real-helpers.mjs` `lateSummary`）：一行 running 都没看到、标题都对，
     而且每个需求的摘要第一次出现时它的每个 task 实例都已经停了（实例会话最后一条条目早于摘要第一次出现）时记 KNOWN（模型的做法），
     detail 写明两个时刻（距驱动开始的毫秒）和回执到 `mori.progress` 之间对话调用的工具；标题不对、没有摘要、摘要出现时还有实例在跑却
     没看到 running 行，照样失败；看到 running 行时核对与原来相同。U46 记在负责人决定的登记里（另一个选项是当作前提没满足重跑）。
   - 核对：用第一遍留下的数据（`mori-v1-real-data-5ff3St`）单独喂给 `lateSummary`：摘要在 `mori.progress` 之后出现时得到
     `{"request":1,"shown":11534,"stopped":6877,"held":["task_create","board_read","board_read","read_session","board_read","reply_via_dialog"]}`
     （记 KNOWN）；假设摘要在 executor 还在跑时（06:28:37）出现、或没有摘要时都是 null（记失败）。
   - 重跑：`--only approval` 10 / 0 / 0。这一次 DeepSeek 先结束了那一段，TB-37 核对了 3 行 running（`Run pwd; ls -a; …`、
     `Waiting for your approval` 等），所以 KNOWN 的那条路在真实运行里没有再走到，只由上面的核对验证。
2. **`sa-real --only read` “SA-16 real read on deepseek / on GLM: the main agent called subagent within 3 attempts”**（6 次都是
   “the main agent did not run subagent (no call with subagent rows)”）。
   - 根因：测试。WP-05（`1487092`，没有网络区域）去掉了 `prepareRealData(source, found, projects, proxyPort)` 的第三个参数（要授权
     公网的临时项目；`474fb10` 的提交说明误写成 grants）；`sa-real.mjs`（`d1a00b3`，在 v1-subagent 上写的）仍然传
     `prepareRealData(source, ctx.found, [], PROXY)`，合并后 `[]` 成了端口，复制出的 `model-config.json` 里两个提供商的地址都是
     `http://127.0.0.1:/p/<id>`。每个请求都立刻失败：会话文件里助手消息是
     `No model available: mori-endpoint/deepseek-flash — can’t connect until …`（GLM 同样），模型一次也没被调用，驱动却把它报成
     “模型没调用 subagent”。“the forward proxy reached the real providers”那一条通过，是因为一个请求也没到代理。
   - 修正（`474fb10`，`app/tests/ui/sa-real.mjs`）：改成 `prepareRealData(source, ctx.found, PROXY)`（与 `tb-real`、`mem-real` 相同）。
   - 重跑：`--only read` 12 / 0 / 0（DeepSeek 与 GLM 各 3 个只读 subagent，每个 1–2 次工具调用，三个的第一个请求相差不到 20 毫秒）。

### 这一组没有做的

1. **只跑了覆盖这一轮变化的五个驱动**（U35、U39）。`tb-real`、`mem-real`、`sa-real` 的 `--only` 写 `*-partial-real.json`，覆盖检查
   不算，所以前面各组记的真实层缺口（模型层 MP-27、MP-40，TaskBoard 七个，记忆四个，subagent 四个）仍在，不带
   `--allow-missing-real` 的覆盖检查仍不通过；要补就整套跑各个 `*-real.mjs`（命令见前面各组“这一组没有做的”第 1 条），由 lead 定。
2. U39 写的两句投递（“你回答后交回”“结案没处理”）这一次的 `approval` 驱动没有走到（需求一次就做完、结案关闭），仍只由单元、
   合成端点自检和 `tb-app-handoff` 查（同 WP-21.md）。`sa-real --only command`（通用 subagent 跑命令的批准卡）不在这一轮要跑的里面，
   没有跑；修正的那一行对它同样生效。
3. **没有验证**：TB-37 记 KNOWN 的那条路只用第一遍留下的数据单独核对过（上面第 1 条），没有在真实运行里再走到一次。

## 打包程序组（测试分层第 4 条）

在提交 `38894ab` 上做（10-27 2:54–3:07，Windows 时间），这一组没有改 `src/`、测试和打包配置。这一轮改了主进程、preload 和打包配置
（都是 WP-20：`674bbae`、`ec5d559`、`81e358a`，`tray.ts`、`index.ts`、preload 的 `setBusySessions`、`electron-builder.yml` 的
`asarUnpack`），加了依赖 mermaid 11.17.2（WP-13），所以除了 `m0-smoke --exe`，还在打包程序上用 `--exe --only` 跑了这些改动自己的用例。
环境：会话没有锁屏（开始时、结束时 `LogonUI.exe` 都不在），所以剪贴板的检查是真的读写系统剪贴板。开始时在跑的 PID 21716（和它的子进程
10752、36856）、17628、1736、占着 4399 端口的 36088 都不是这一组起的，没有动；这一组起的 Mori、node 都随套件退出了（跑完查过，
4300–4999 端口只有 36088 的 4399 在听）。跑完时另有一个 3:04:12 起的 `D:\Git\usr\bin\sleep.exe 590`（PID 19408，父进程 8532 已不在），
不是这一组起的：`app/` 的源码、测试和合成端点里都没有 590 这个数，这一组的套件发的 `sleep` 命令最长 127 秒，而且 Mori 退出时
作业对象会结束它的命令；留着没动。

准备：

1. 工作树的 `app/node_modules` 原来是指向主检出 `D:\code\mori\app\node_modules` 的目录联接；electron-builder 顺着联接找不到生产依赖
   （WP-20 集成记录：`app.asar` 只有 71 MB）。`cmd /c rmdir` 只删了联接（没有碰它指向的目录），再
   `robocopy D:\code\mori\app\node_modules <工作树>\app\node_modules /E` 复制了一份（25 秒，robocopy 退出码 1 = 复制了文件）。
   之后主检出的 `node_modules` 仍在（顶层 493 个目录，有 mermaid 11.17.2），工作树里的是同样 493 个目录的真目录（不再是联接）。
2. `npm run dist:dir` 通过（检查、`electron-vite build`、`electron-builder --win dir`）；`out/` 也随之按同一提交重建。没有
   "cannot find path for dependency"。`dist/win-unpacked/resources/app.asar` 156,455,157 字节（约 156 MB，同 WP-13、WP-20 的集成，
   不是 71 MB）；`app.asar.unpacked/out/main/chunks/tray-BZ9f3J6W.ico`（43,006 字节）在。

| 命令（在 `app/` 下，`<exe>` = `dist/win-unpacked/Mori.exe`） | 结果（通过 / 失败 / KNOWN） | 秒 | 说明 |
| --- | --- | --- | --- |
| `npm run dist:dir` | 通过 | 246 | 构建 23 秒，其余是检查与 electron-builder |
| `node tests/ui/m0-smoke.mjs --exe <exe>` | 40 / 0 / 1 | 46 | KNOWN 1：命令超时后留下 `sleep` 进程（pi #9129，上游）。`app.asar` 的 `node_modules` 顶层 256 个包，没有 mermaid、@mermaid-js/parser、cytoscape、katex；mermaid 图从 `app.asar` 的懒加载块离线画出；net-watch（`tests/ui/net-watch.mjs`，由 `m0-smoke` 对 `Mori.exe` 的进程树采样）采样 50 次，看到到合成端点 4319 的回环连接，没有对外连接；托盘、应用菜单、确认框、单实例、后台进程意外退出后 "Exit" 都过；打印 NOTE 行（见下面"这一组没有做的"第 1 条） |
| `node tests/ui/m2-app.mjs --exe <exe> --only taskbarFlash,noticeUnwritable,hiddenFlash,hiddenKernelExit,closeKeepsCard,quitTwoSessions,exitNoDialog` | 12 / 0 / 0 | 34 | setup 1、任务栏闪烁 2、写不进标记文件 2、藏着时出批准卡 2、藏着时后台进程退出 1、关窗口前的批准卡 1、两个会话时的复数说明 1、确认框弹不出来 1、页面没有报错 1 |
| `node tests/ui/m6-app-settings.mjs --exe <exe> --only thinkingUnsupported,markReasoning,thinkingLevels,unmarkReasoning,agentsUser,reopen` | 37 / 0 / 0 | 29 | `reopen` 里的 `closeWithDraft`：有未保存的 AGENTS.md 时关窗口藏进托盘、托盘 "Exit" 不问；经托盘 "Exit" 退出后同一数据目录重启（单实例锁已放开） |
| `node tests/ui/m3-app.mjs --exe <exe> --only extOpen,extCloseWindow` | 8 / 0 / 0 | 11 | 关窗口前已在等的扩展询问卡，回来后照常作答 |
| `node tests/ui/m5-app.mjs --exe <exe> --only trayKeepsLayout,menuSplit` | 6 / 0 / 0 | 8 | 藏进托盘再回来仍是分屏，会话、焦点、草稿不变 |
| `node tests/ui/tb-app-flow.mjs --exe <exe> --only approve,hidden` | 5 / 0 / 0 | 33 | 窗口藏着时 task 实例照常做完、需求结案；写 `tb-partial-app-flow-packaged.json` |
| `node tests/ui/mem-app-enhance-a.mjs --exe <exe> --only hiddenRun` | 2 / 0 / 0 | 28 | 窗口藏着时增强任务照常跑完；写 `mem-partial-app-enhance-a-packaged.json` |
| `node tests/ui/mem-app-enhance-b.mjs --exe <exe> --only exitDuring` | 3 / 0 / 0 | 34 | 只有增强在跑时托盘 "Exit" 不问、20 秒内退出，下次启动记失败并重跑那一天；写 `mem-partial-app-enhance-b-packaged.json` |
| `node tests/ui/m4-app.mjs --exe <exe> --only changes,toolPath,reread,openExternal,viewerStates,previewOpens,previewQuote,previewSend,previewToggle,copyPath,expandAttach,expandApproval,activityLog,narrowHeader,replyMarkdown,expandRestart` | 52 / 0 / 0 | 55 | WP-13 的打包层（新依赖）：预览里的 mermaid 图从 `app.asar` 载入、复制路径走打包后的主进程剪贴板；步骤是 WP-13 集成清单的 16 步（包含它当时在打包程序上跑的 10 步） |

用例怎么选的：主进程的托盘与应用菜单按 WP-20 记录"状态表各行的用例"表里每一个点到托盘、菜单、确认框或窗口藏起的用例，加上 U10
的两步（`noticeUnwritable`、`exitNoDialog`）和"任务栏闪烁"的 `taskbarFlash`；`m6-app-settings` 带上 `reopen` 的前置
（`thinkingUnsupported` 到 `unmarkReasoning`，WP-20"集成时定下的"第 4 条）。新依赖 mermaid 由 `m0-smoke --exe`（`app.asar`、离线画图、
net-watch）和 `m4-app --exe`（预览里的图）覆盖。

留下的结果文件：`test-results/m0-smoke.json`（`m0-smoke` 带不带 `--exe` 都写这个名字，现在是打包程序的结果，`target` 是 `Mori.exe`；
它不是哪份规格的覆盖层文件）、`m2-app-packaged.json`、`m3-app-packaged.json`、`m4-app-packaged.json`、`m5-app-packaged.json`、
`m6-app-settings-packaged.json`（这几个套件 `--only` 时照样写这个名字，内容只有这次选的步骤）、`tb-partial-app-flow-packaged.json`、
`mem-partial-app-enhance-a-packaged.json`、`mem-partial-app-enhance-b-packaged.json`（`--only`，覆盖检查不算）。各次输出在会话的
scratchpad（`m0-smoke-exe-1.log` 等）。

### 失败与修正

没有失败的检查，这一组没有提交修正（只提交这一节记录）。唯一的 KNOWN 是 `m0-smoke` 的 pi #9129（上游，原有）。

### 这一组没有做的

1. 打包程序上托盘的悬停说明和右键菜单是不是那份菜单：Playwright 对打包程序不加 `-r`，打包程序也不认 `-r`，`tray-hook.cjs` 载不进去，
   `Tray` 又没有读取接口；`m0-smoke --exe` 打印
   `NOTE the tray tooltip and context-menu checks need tray-hook.cjs (dev build only)`，不记检查（WP-20"不能自动测的"第 2 条）。
   这两项只在开发构建的 `m0-smoke` 上查，打包程序用的是同一份 `tray.ts`。
2. 安装包（NSIS）的大小：`npm run dist:dir` 不出安装包，测试分层第 4 条也不要求，没有跑 `npm run dist`。
3. 工作树的 `app/node_modules` 现在是主检出那份的完整副本，不再跟着主检出变；主检出以后重装依赖时，这个工作树要重新复制或改回联接。
