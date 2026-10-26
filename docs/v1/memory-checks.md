# 提示词分层与记忆 检查记录

依据：[构建规格](../specs/memory.md)（下称“规格”），它实现 [提示词分层与记忆 Proposal](../proposals/prompt-and-memory.md) 第一版（2026-10-22）。
在 `app-v0` 上做（2026-10-22 同步到 `origin/app-v0` 的 046a9ca，含英文界面、v1 模型层与平行 Agent 与 TaskBoard），没有另开分支，没有提交。

## 状态

实现与测试完成（2026-10-23，`app-v0` 工作树，没有提交），等你走查与确认下面的选择。最后一次在开发构建上依次跑完整的
`npm run test:memory`（2026-10-23）：记忆的单元、App、回放全部通过；MEM-35 里 `m4-app` 原有的时序竞争失败一次，改了测试的拖选方式（见下面）、
单独连跑 12 次都通过后，MEM-35 与覆盖检查再完整跑一次：

| 层 | 结果 |
| --- | --- |
| 单元 | `npm run test:mem-unit` 222/222；`npm run test:unit`（模型层）373/373；`npm run test:tb-unit` 329/329；`npm run check` 通过 |
| App（合成端点） | prompt 46、tool 54、page 104、enhance-a 75、enhance-b 30、team 50、settings 80，全部通过 |
| 回放 | `mem-replay` 62/62（合成端点录制的 6 个 fixture，标 synthetic） |
| 真实模型 | 没有运行：这台机器没有带 key 的数据目录（§0 第 4 条） |
| 现有功能（MEM-35） | App 23/23（m0-smoke、m1–m6、v1-models、`tb-build-base`、9 个 `tb-app-*`；m0-smoke 那条 `KNOWN` 是 pi #9129，同以前）；回放与单元 12/12（含两份覆盖检查，都带 `--allow-missing-real`）；同时写了 MP-37 与 TB-46 |
| 覆盖检查 | `node tests/spec-coverage.mjs --spec memory --allow-missing-real`：every item is covered on every listed layer（真实层 MEM-05、MEM-10、MEM-22、MEM-34 为 pending） |

另外：实现中做过一次按区域的代码审查（6 个审查 + 27 个对抗核实），核实为真的 19 条全部修好；最后的完整性审查找出的两处测试缺口已补上（MEM-30 回放层的界面动作记录、MEM-23 协作模式的 token 之和，各有一个对抗核实：改掉一个期望值时检查会失败）；测试中发现的程序问题见下面“与规格不同、或需要你注意的地方”。

## 负责人的决定（2026-10-22，写规格时问的）

| # | 问题 | 你的回答 | 现在的做法 |
| --- | --- | --- | --- |
| 1 | 增强任务打开协作模式时谁拿 memory 工具 | 立项 Agent 和 task 实例 | 规格 §0 第 1 条、§7.2：关闭时主 Agent；打开时合并会话的增强会话本身、分开时的立项实例、task 实例（含只读 task） |
| 2 | 有 `SYSTEM.md` 时身份段用谁的 | 总是 Mori 的 | 规格 §4.3：项目与用户级的 `SYSTEM.md` 都不用，每个会话记一次日志 |
| 3 | 每天的时刻全应用一份还是每个项目一份 | 每个项目一份 | 规格 §9.1、§9.2：时刻也是这个项目的日界；只有一个定时器，设在最早的项目时刻 |
| 4 | 这台机器没有带 key 的数据目录 | 先用合成端点录回放，真实套件写好、等你跑 | 回放 fixture 标 `source: 'synthetic'`；`tests/ui/mem-real.mjs` 没有运行，覆盖检查带 `--allow-missing-real` |

proposal §16 “默认做法”一列全部照做（规格开头说明）；§16 最后一段交给规格的参数登记在 [defaults.md](defaults.md) 的“提示词分层与记忆”一节。

## 负责人的决定（2026-10-26 走查）

走查记录 [walkthrough-1026-checks.md](walkthrough-1026-checks.md)，这一包的检查记录 [walkthrough-1026/WP-07.md](walkthrough-1026/WP-07.md)。两条都是负责人的决定，不是临时默认值（不登记在 defaults.md）。

| # | 负责人原话 | 现在的做法 |
| --- | --- | --- |
| M4 | the AGENTS.md should put in customize rather setting | 用户级 AGENTS.md 的编辑器连同项目加载的文件、token 数，从设置页挪到 Customize 的第一节 `AGENTS.md`（跟随 Customize 的会话、不等 `tools.get`）；设置页只剩 Models、UI issues；记忆页 AGENT 的链接改为 `Edit in Customize`（规格 §10.3、§10.8，状态表 [customize-agents-md.md](screens/customize-agents-md.md)） |
| M15 | budget for AGENT.md is too short, expand to 2000tokens | 提醒线由 500 改为 2000（`shared/memory.ts` 的 `AGENTS_LIMIT`，记忆四种的 `MEMORY_LIMIT` 仍是 500）；仍然只是提醒，比的是全部加载文件的合计，什么都不截断（模型本来就拿到全文）；数字按千分位写（规格 §10.3，proposal §5.2 的 2026-10-26 注） |

## 规格的评审与改动

- 规格草稿经过一轮五个角度的对抗评审（偏离 proposal、在 pi 与现有代码上能否实现、完整与可测、内部一致、界面文字），71 条意见核实后保留 59 条，全部改进规格
  （其中两条阻塞：增强会话的开始、结束与失败只能按事件判断，因为 `sessions.ts` 的 `prompt` 立即返回、错误变成事件；这台机器上 MEM-35 的覆盖检查必须带 `--allow-missing-real`）。
- 实现中按代码与测试改的规格（都不改 proposal 的心智模型）：
  - 身份段去掉 “on their Windows computer”：pi 默认的 bash 准则让默认工具下的身份段到 505 token，去掉后量得 498（≤ 500，MEM-01）。
  - §3.2：`Details` 取第一个 `## Details` 到最后一个 `## Revisions` 之间（你在 Details 里写的 `## ` 小标题不截断它）。
  - §3.1：索引与 detail 不一致时，下一次写这一层这一种时重写这一种的索引。
  - §7.6、MEM-11、MEM-31：分开时对话调用 `memory` 得到 pi 的 `Tool memory not found`（pi 在 `tool_call` 处理器之前就拒绝没启用的工具，同 TB-09 的 `bash`），不是 `RELAY_ONLY`。
  - §8：`enhance.get` 带 `effortPicks`（设置对话框的 Effort 按内核算的第一个候选，不在界面里另算）；`session.read` 加可选的 `anchor`（依据跳转在会话还在生成、会话文件超过 1 MB 时也找得到）。
  - 附录 B：起点紧接水位时写 `(after entry <id>)`，否则写起点的时间。

## 开工前查的 pi 行为

脚本在 `app/tests/prechecks/memory-hooks/`（`node tests/prechecks/memory-hooks/m1.mjs` 等，输出写到系统临时目录），结果见规格 §11.2 的 M1–M7。要点：
`before_agent_start` 里设 `customPrompt` 能换掉身份句并覆盖 `SYSTEM.md`，但 pi 的工具清单、规则也随之没有，所以 Mori 照 pi 的写法自己渲染；每次运行写同样的分节不记补丁；
`tool_call` 返回 `{ block, reason }` 时模型收到的就是 reason；`getSessionStats` 只对开着的会话有效（实例在运行中途已关闭，所以 token 从会话文件累加）。

## 交付了什么

- **后台进程**（`app/src/kernel/`）：`memoryFiles.ts`、`memoryRules.ts`、`memory.ts`（记忆模块：读写、预算、修订、回滚、运行的修订）；`memoryText.ts`、`memoryAssemble.ts`
  （身份段、分节、工具说明、第一条消息、分发）；`memoryTool.ts`、`memoryExtension.ts`（`memory` 工具、`mori-memory` 扩展、写保护）；`enhanceDays.ts`、`feedbackRead.ts`、`enhance.ts`、
  `enhanceRun.ts`（日子与片段、反馈、调度与队列、一次运行）；`memoryCommands.ts`（`memory.*`、`enhance.*`）；`sessions.ts`、`team.ts`、`teamHost.ts`、`instances.ts`、`approval.ts`、
  `resources.ts`、`agents.ts`、`commands.ts`、`index.ts` 的接线（看不见的会话、新会话的提示、`Team.busy()` 盖住两次投递之间的空隙、AGENTS.md 的 token）。
- **进程桥**：`app/src/shared/memory.ts`（新），`protocol.ts`、`feedback.ts` 的改动。
- **主进程**：`main/review.ts` → `main/issues.ts`（只剩 UI issues，通道 `mori:issues-*`）；`shared/review.ts` → `shared/issueRecords.ts`。
- **界面**：记忆页（`Memory*.tsx`、`state/memory.ts`、`styles/memory.css`）；设置页的 UI issues（`UiIssues*.tsx`、`state/uiIssues.ts`）；工具卡的 `View in Memory`；新会话的提示；
  反馈表单的说明；F8 的 `View in Settings`；离开确认框的标题由检查给出；工作回顾页删除。
- **测试**：单元 `tests/unit/memory/`（`npm run test:mem-unit`）；App `tests/ui/mem-app-{prompt,tool,page,enhance-a,enhance-b,team,settings}.mjs`；回放 `tests/ui/mem-replay.mjs` 与
  `tests/fixtures/mem/`（合成端点录制，`mem-record.mjs`）；真实 `tests/ui/mem-real.mjs`（未运行）；合成端点的增强脚本 `tests/fake-endpoint/enhance.mjs` 与场景
  `scenarios/mem.mjs`、`mem-prompt.mjs`、`memtool.mjs`；`tests/spec-coverage.mjs --spec memory`；`npm run test:memory`。m7 的套件与 fixture 删除；§14.4 列出的现有测试已改。
- **文档**：规格；`docs/v1/screens/memory-page.md`、`memory-enhance.md`、`memory-chat.md`、`settings-issues.md`；规格 §13 列出的其他文档的注明与改动；`docs/v1/defaults.md` 的新一节。

## 实现时定下的、规格没写到的（临时，走查时可以改）

| # | 选择 | 理由 |
| --- | --- | --- |
| 1 | 同一秒的两次修订，id 的后缀在前一个上加一，按名字排序就是写入顺序 | “之后又改过它的修订”按顺序找 |
| 2 | 增强写入的 `created`、`modified`、`## Revisions` 行与 slug 里的日期用日子 D；别的写入用今天 | 与规格 §3.2、§3.3 的例子一致 |
| 3 | 只有用户级就超出时的原文 `Over the 500-token limit for <KIND>: user <n>. Merge or delete entries first.`；没有这一种条目的项目不参与“写用户级时”的检查 | §6.3 只给了两层相加的原文 |
| 4 | 增强会话里 §9.6 的拒绝先于记忆目录的写保护 | 增强会话里 `write`、`edit` 一律拒绝，原因说清楚 |
| 5 | 没打开过增强时 `thinking` 为空，`enhance.get` 报 `medium`；打开时按 §9.1 取 | 打开时才知道默认范围 |
| 6 | 新的原因文字：`The run ended without a reply.`、`The reply ended with “<stopReason>”.`、`Enhancement is off for this project.`、`This revision no longer exists.`、`This revision has no changes.`、`This enhancement run has already ended.`、`The entry file doesn’t exist.` | 规格没给这些情况的原文 |
| 7 | 失败的运行：建了会话时 Notes 是它最后一条回复，没有回复时是失败原因 | §9.8：Notes 是最后一条回复；没建会话时是原因 |
| 8 | 刚启动、模型层还没就绪时 `effortPicks` 为空，Effort 显示 `Choose a model first.`，记忆页下一次读时更新 | `enhance.get` 不等模型层，免得挡住记忆页 |
| 9 | 参数还在流入时 memory 工具卡的目标写作 `…` | 同 v0 工具卡（memory-chat.md 登记） |
| 10 | `project.json` 记 `path.resolve(cwd)`，比较区分大小写 | 同 pi 的会话目录 |
| 11 | `Team.busy()` 在一个实例运行结束到下一步排好之间仍为真（多出几毫秒） | 增强会话的结束条件按它判断；TaskBoard 的检查都照样通过 |
| 12 | 状态表里标“临时”的其余界面细节 | 见 `docs/v1/screens/memory-*.md`、`settings-issues.md` 各自的“本表定下的界面细节” |

## 与规格不同、或需要你注意的地方

- 跑测试时发现并修好的程序问题：协作模式下增强运行在两次投递之间的空隙里提前结束（`Team.busy()`）；结束的进度发得比“正在跑”清掉早，记忆页一直显示 `Running…`（现在先清掉再发）；
  依据跳转在会话还在生成时找错消息（改用 `session.read` 的 `anchor`）；代码评审的 19 条（3 条中等）全部修好。
- 最后的完整性审查找出五处实现照规格做了、但规格没说明是临时选择的行为，补登记在规格 §12 与 [defaults.md](defaults.md)：看不见的会话把没有信任决定的项目按不信任；
  运行中关掉增强会停下这次并记失败；协作模式里有需求等你拿主意时运行照样结束；`agent` 调用方的 `save`、`update` 必须带 `quote`；在记忆页改一条“它学的”之后算“你说的”。
- 在协作模式下保存过、这次之前的会话：回到关闭模式时按记下的工具恢复，这时补上 `memory`（不做迁移）。
- `Couldn’t load sessions, so the original session can’t be opened.` 在 App 里触发不到：pi 的 `listAll` 出错时返回空列表，不会失败。
- `tests/ui/m6-app-tools.mjs` 里 MCP 保存后的 `New session` 那条检查改读顶栏的项目名（规格 §14.4）：项目里连不上的 MCP 服务让 pi 在会话打开后几百毫秒发
  `MCP servers need attention`，对话流有了这一项空状态就不显示，它与检查的读取只差几毫秒。加了计时之后，记忆之前的构建（046a9ca）在这台机器上同样失败，
  所以这是原有的时序竞争，不是这次的功能回退。
- `tests/ui/m4-app.mjs` 走查 4（生成中选字）偶尔选错一句（规格 §14.4）：按下鼠标之前流入的字把对话流滚到底，鼠标落到下一两行。逐帧记录看到两个来源：
  测试把那句话滚到视野中间时离底部只有 23px（不到 24px 的余量），跟随恢复；往上滚 120px 时，跟随记下的“自动滚到底的位置”还是按住鼠标之前的，
  往上滚不比它更靠上、不算离开底部（Transcript.tsx 的写法，v0 的设计，这次没改）。记忆之前的构建（HEAD）6 次里失败 1 次，所以是原有的时序竞争。
  同样拖选方式的“浮层开着时 Esc”那一步在 45 次里失败过 1 次。两步现在都先等跟随自己滚到底、再往上滚、拖选时不再滚动，断言不变。

## 未验证

- 真实模型一层（MEM-05、MEM-10、MEM-22、MEM-34）：`node tests/ui/mem-real.mjs --source <你的数据目录>` 写好了、没跑过（只在合成端点上跑过一份改了模型来源的副本，26/26）。
  模型会不会真的调用 `memory`、增强运行会不会改条目、内网模型对身份段与第一条消息的理解，都还不知道。
- 模型层与 TaskBoard 的真实层（MP-27；TB-04、TB-08、TB-34、TB-37、TB-45）这次没有重跑。
- 安装包（`--exe`）上的 App 套件没有跑。
- 夏令时：这台机器在 Asia/Taipei，没有夏令时，日界的换算没有在夏令时切换日测过。
- `Couldn’t load sessions, so the original session can’t be opened.`（依据跳转时会话列表读取失败）在 App 里触发不到。
- 身份段的 token 数（498）只按规格 §6.3 的估算；真实模型的分词器算出来的数不同。
- MEM-30 的回放：`Jump to source from Memory` 只核对了动作记录与发出的 `session.read`（带 `anchor`）；录制里没有 `session.read`，回放桥答
  `Session file not found`，跳转落到哪条消息由 App 层的 MEM-10 检查。`Move to this project` 只在单元层（没有录过从用户级放回本项目）。
  回放里读动作记录要保存一份 F8 报告（对话框里没有 Recent activity），回放桥只把它记在内存里，不写文件、不发命令。
- MEM-23 的协作模式：检查算的是增强会话与这次 team 目录下全部实例文件的和；T1 的实例“在运行结束前关闭”看不到直接的事件（看不见的会话不转发、
  会话文件不记关闭），用 board.json 里 T1 已完成、它的最后一条早于完成来代替。
- 你的走查：记忆页、增强设置与运行、对话里记一条、新会话的提示、设置页的 UI issues、F8 的 `View in Settings`。

## 2026-10-26 走查 M19、M17 的改动（WP-11）

负责人回答 M19 后，主 Agent 主动记你说出的长期事实和你纠正它时的规则，主动记的算 Mori 记的（`source: agent`，界面 `Added by Mori`），
开着增强时增强任务可以改它们、把它们移到该在的种类（规格 §0 第 5 条、§6.4、§6.9、新验收 MEM-38）；身份段里交出去的那一句只在有交出去的工具时出现
（§4.1、附录 A.1.1）。改了什么、按推荐定下的选择、没验证的与集成阶段要跑的见 [walkthrough-1026/WP-11.md](walkthrough-1026/WP-11.md)。
上面“未验证”里的身份段 token 数（498）现在是默认工具下 454。

集成时（2026-10-26）真实模型一层第一次跑（只跑了 `--only dialog,enhance`，结果在 `mem-partial-real.json`，不算进覆盖检查）：
DeepSeek 主 Agent 在对话里四句都用 memory 记下，明说的给了 `asked: true`、不带“记一下”的长期事实主动记成 `Added by Mori`；
GLM 的增强第一次三个任务都没有改动，重跑一次 REVIEW 加了一条，回滚通过；没有发生移动。dialog 14/14、enhance 15/15，
完整的三个驱动和不带 `--allow-missing-real` 的覆盖检查留到推送前。详细见 [walkthrough-1026/WP-11.md](walkthrough-1026/WP-11.md)“跑过的”。
