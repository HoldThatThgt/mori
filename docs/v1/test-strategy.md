# 三层测试（2026-10-28 负责人定）

负责人的话（2026-10-28）："a full pass test run last over 10+ hrs, which is unacceptable"，接着定了三层：

> 2 mins test suite for during coding quick test
> 20 mins test suite for feature conclusion and push
> 3h full test suite on version publishing

同一天的两个回答：第二层跑这个功能自己那组的套件，20 分钟放不下时挑着跑（"Own feature's suites"）；真实模型与打包程序在
第三层全跑，第二层只在改到时跑相关的用例（"Publish; push only if touched"）。规则写在 AGENTS.md“测试分层”；本文是原因、做法、
实测与没有验证的。做法上的临时默认值登记在 [defaults.md](defaults.md)“三层测试”一节。

## 1. 原来时间花在哪里

数据取自 [walkthrough-1026/regression.md](walkthrough-1026/regression.md)（2026-10-26 那次完整回归每个套件的秒数）、
[finish-check-checks.md](finish-check-checks.md)、[fs-checks.md](fs-checks.md)。

- 每个套件各跑一次、串行，约 2.5 小时（m0–m6 约 27 分钟，模型层 18，TaskBoard 33，记忆 15，一键拉取模型 7，subagent 与
  Agents 5，收尾检查与文件系统估 45–50）。这一项不是 10 小时的来源。
- “现有功能不退步”的七个汇总（MP-37、TB-46、MEM-35、MD-15、AG-11、FC-28、FS-115）由 `v1-models-existing.mjs` 以子进程
  **重新跑**前面所有规格的套件，一份比一份长：MP-37 26 分钟、TB-46 44、MEM-35 72、MD-15 约 95、FC-28 约 105、FS-115 估 2 小时。
  原来的第 3 条（完整回归）是 FS-115 加 AG-11 再把每个套件直接跑一遍，同一个构建上每个套件跑两遍；各规格的总命令都跑时光汇总就是
  约 7.8 小时，m1-app 在里面跑 7 次。每加一份规格，汇总再长一截。
- 结果文件不记是哪个构建、哪版测试跑的，`--only` 的结果又不算，任何修正之后的稳妥做法都是整套重跑：2026-10-26 那次 MD-15 跑了
  五遍，13 个修正里 10 个只改测试。
- 13 个回放套件各自用 vite 把同样的输入建一遍回放页面（每次约 14 秒）。

## 2. 现在的做法

### 2.1 三层

| 层 | 命令 | 跑什么 | 预算 |
| --- | --- | --- | --- |
| 1 写代码时 | `npm run test:quick` | 第 1 段同时：检查、构建、回放页面；第 2 段四条线同时：冒烟、三段回放（`--only`）、两条单元测试线（八组） | 2 分钟 |
| 2 功能做完、推送前 | `npm run test:push -- --family <组>` | 第 1 层；这一组的套件整套跑、放进 18 分钟，结果还算数的不跑，放不下的列出来留给第 3 层；改到模型看到的、打包配置或主进程 / preload、NSIS 时另跑相关的用例（不算在 20 分钟里） | 20 分钟 |
| 3 发版前 | 真实层（负责人用 key），再 `npm run test:publish` | 第 1 层；全部套件各一次（戳还对得上的不重跑）；汇总 FS-115、AG-11（只收集）；八份 `spec-coverage --fresh`；`dist:dir`、`m0-smoke --exe`、`m1-app --exe`、`test:uninstall` | 3 小时 |

组名是 `v0`（m0–m6）、`model`、`taskboard`、`memory`、`discovery`、`subagent`、`agents`、`finish`、`filesystem`；组里的套件从
package.json 的各组总命令读（`tests/ui/run-plan.mjs` 的 `FAMILY_SCRIPTS`），不另写一份列表。原来没有任何命令跑的
`m0-shell`、`m6-app-tool-switches` 加进了 `smoke` 与 `test:m6-app`，于是也在 `v0` 组里。

### 2.2 结果文件的戳（`app/tests/ui/stamp.mjs`）

`createRecorder` 与 `m0-smoke` 写结果文件时带 `stamp`：`script`（写它的脚本）、`tests`（脚本与它在 `tests/` 里传递 import 的
文件，加上合成端点、MCP 服务、pi 包、全部 fixture 与 `tests/ui` 下不是 .mjs 的文件的哈希）、`build`（App 与真实层是 `src`、`vendor`、
`package-lock.json`、构建与 TypeScript 配置的哈希，`out/` 比 `src` 旧时为空；回放是回放页面的输入；`--exe` 是那份 `app.asar`）、
`commit`、`dirty`、`at`。一份结果“还算数”：有戳、`tests` 与 `build` 都和现在相同、至少一条通过、没有失败。只改一个套件的测试
只让它自己（和 import 了改过的助手的套件）重跑；改后台进程不让回放重跑。

### 2.3 汇总改为收集

`v1-models-existing.mjs --id <编号>` 对列表里的每个套件读它整套跑出的结果文件、按戳判断，每个套件照旧记一条
`<编号> <脚本名>`，不算数时细节写原因（`missing`、`no stamp`、`failed`、`stale`）和要跑的命令。单元测试、覆盖检查、标记检查与
TB-03 的对照构建照旧以子进程跑。七条“现有功能不退步”的意思（现有测试全部通过）不变，证据从“汇总里又跑了一遍”变成“这个构建、
这版测试上整套跑过、通过”。七份规格里描述汇总的小节都加了 2026-10-28 的注。

### 2.4 运行器与共用的回放页面

- `app/tests/ui/run.mjs`：`--tier push --family …`、`--tier publish`、`--suites a,b`、`--rerun`、`--budget`、`--dry-run`。
  跑之前按需构建、建回放页面、建 TB-03 的对照构建；套件一个接一个跑，日志在 `test-results/run/`，每跑完一个把实测秒数写回
  `app/tests/suite-seconds.json`（随检查记录提交），最后写 `test-results/run-summary.json`。选择规则在 `run-plan.mjs`（纯函数）。
- `app/tests/ui/harness-page.mjs`：回放页面按输入的哈希建在 `test-results/harness-page/<哈希>/`，输入不变就直接用；13 个回放
  套件（含 `mem-replay-helpers.mjs`）都改用它，`v1-models-replay --fixtures` 的自检照旧自己建。
- `spec-coverage --fresh`：App 与回放层只认戳还对得上的结果文件，对不上的列为 stale、不计入。

## 3. 实测（2026-10-28 至 29，本机，`app-v0` 工作区）

| 项 | 原来 | 现在 |
| --- | --- | --- |
| 每次改动的集合 | `test:min` 约 110 秒 + `test:quick` 97 秒（另含一次 19 秒的构建） | `npm run test:quick` 三次：132 秒（八组单元与构建同时跑，构建慢到 84 秒、TB-84 失败，改了分线）、103 秒、115 秒；最长的一项是冒烟测试（单独 47–58 秒，和单元同时跑时 86–96 秒） |
| `npm run test:push -- --family agents` | — | 162 秒：第 1 层 115 秒，`ag-app` 46 秒（60 条通过） |
| 第二遍 `run.mjs --tier push --family agents --dry-run` | — | `ag-app` 记为 still valid、不跑 |
| AG-11 汇总 | 541 秒（重跑六个套件） | 不到 1 秒（收集）；跑过 `m6-replay` 之后它记为通过，没跑过、没戳的六个各写明原因 |
| 回放套件（共用回放页面） | `m6-replay` 43 秒、`md-replay` 29、`sa-replay` 23、`v1-models-replay` 84 | 27、12、8、68 秒，检查数相同（71、104、16、42，全部通过） |
| 回放页面构建 | 每个回放套件一次，约 14 秒 | 输入不变时 0 秒 |

按 `suite-seconds.json` 估：第三层的套件约 170 分钟（57 个要跑、5 个已算数），再加第 1 层、汇总与覆盖检查、打包与卸载约 10 分钟，
约 3 小时。第二层从头跑时各组：`v0` 22 分钟、`model` 17、`taskboard` 33、`memory` 15、`discovery` 12、`subagent` 3、`agents` 1、
`finish` 15、`filesystem` 47（后三个大多是估的），放不进 18 分钟的组每次推送挑一部分，按上次跑的时刻轮换。

## 4. 没有验证的

- 第三层没有整个跑过（按规则只在负责人要求发版时跑），3 小时是估的：12 个套件没有实测用时（`md-app-form`、`md-app-card`、
  `fc-app-check`、`fc-app-team`、`fc-replay`、`fs-app-changes`、`-rewind`、`-gate`、`-work`、`-away`、`-question`、`fs-replay`），
  按 300 秒估；真实层（负责人先跑）不在这 3 小时里，2026-10-26 那次 `tb-real` 一项就 7–42 分钟。第一次发版跑完后按
  `run-summary.json` 的实测再看是否要减。
- 现有的结果文件都没有戳（2026-10-28 之前写的），第一次第三层会把全部套件跑一遍；之后的第二层、第三层才开始省。
- 第一层的余量不大（103–115 秒），冒烟测试和单元同时跑时变慢；机器更忙时可能超过 2 分钟（会打印 SLOW）。
- 第二层除 `agents` 组以外没有整组跑过；`run.mjs` 的准备步骤里“`out/` 比 `src` 旧时先构建”和对照构建 `tb-build-base` 没有
  实际触发过（这次的 `out/` 是新的、`.tb-runs/base` 已在）。
- 两条线同时跑 App 套件（原提案 3.5）没有做：负责人的三层里不需要它；第三层超出 3 小时时再试。

## 5. 过时的用例：查了什么、删了什么

### 5.1 查的办法与结论

- `tests/` 下每个文件都查了谁跑它（package.json、`v1-models-existing.mjs` 的 `SUITE_LISTS`、`quick.mjs`、`spec-coverage.mjs`
  的结果文件前缀）、谁 import 它、文档里有没有写怎么手工跑：没有没人用的测试文件。fixture（142 个，19 MB）每个都有回放或单元
  测试读。单元测试每个文件都在 package.json 的某个 glob 里。
- 已删的行为（WP-04 的取消探针、`heldPollMs`、`probeCancelMaxTokens`、`longInputFractions`、网络区域、m7）在测试里只剩说明删除
  原因的注释和“查它已经不在”的检查。`tb-app-roles.mjs` 的 `addBaseFields` 给 TB-03 的对照构建（`BASE_REF = 2e67197`）补旧字段，
  对照构建换到新的提交之前还要用。

### 5.2 删掉的（2026-10-28）

没人调用的测试助手（导出了、没有任何文件 import、本文件里也不用；删后 esbuild 把全部界面测试入口打包一遍，没有缺导出的错误）：

| 文件 | 删掉的 | 说明 |
| --- | --- | --- |
| `tests/ui/m6-helpers.mjs` | `lastReply` | 各套件用的都是 `m3-helpers.mjs` 的同名函数；这个版本还在找 `src` 里早已没有的 `[data-testid="assistant-text"]` |
| `tests/ui/m6-helpers.mjs` | `chooseModel` | 用到范围菜单的套件都经各自组的助手选 |
| `tests/ui/m5-helpers.mjs` | `rowClasses` | |
| `tests/ui/tb-helpers.mjs` | `linesBySession`、`sessionKey` | `sessionKey` 只被 `linesBySession` 用 |
| `tests/ui/fs-away-helpers.mjs` | `COUNTDOWN_PATTERN`、`emitWindow`、`emitMain` | `fs-app-away` 用自己的正则加 `COUNTDOWN_ACTION`；`emitMain` 只被 `emitWindow` 用 |
| `tests/ui/fs-real-setup.mjs` | `recUi`、`recSteps`、`recWaitEvent`、`recSettled`，`poll` 的 import | `poll` 只被后两个用 |

另外 13 个回放套件里各自的回放页面构建（同样的输入、各自的输出目录）换成了 2.4 的共用构建。没有删任何检查。

### 5.3 留着的

- `test-results/` 里没有套件再写的旧结果与旧的回放页面（`m7-*`、`harness-m7`、`run-all*`、`m2-app-probe*`、`m3-regress`，
  以及 `harness`、`harness-m2` … `harness-tb` 这些原来各套件的回放页面目录）：被 `.gitignore` 忽略，不影响结果，要不要清掉
  由负责人定。
