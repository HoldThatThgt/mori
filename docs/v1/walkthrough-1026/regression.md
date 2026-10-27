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
