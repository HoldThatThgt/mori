# 临时默认值（v1）

实现时需要一个值、但还没有经过你确认的地方都登记在这里。每一项都是“临时默认值”，拿到依据后再定。
第一张表是模型层，来源：[统一模型提供商构建规格](../specs/model-providers.md) §12；位置是规格 §2 定下的代码落点，时长都集中在 `app/src/kernel/modelTimings.ts`。
后面的平行 Agent 与 TaskBoard、提示词分层与记忆、一键拉取模型各成一节，来源写在各节开头。
v0 的临时默认值仍在 [v0/defaults.md](../v0/defaults.md)，被 v1 各规格取代的行在那里注明。

| 默认值 | 取值 | 位置 | 理由 | 何时复查 |
| --- | --- | --- | --- | --- |
| 每个 key 的并发上限（新提供商的默认）/ 范围 | 4 / 1–64 | `app/src/kernel/modelConfig.ts`（校验）；`app/src/kernel/modelPool.ts`（槽位） | 一个 key 同时跑几个会话够用，又不至于一上来就把内网小部署压满；64 是防手误的上限 | 拿到内网端点、知道它的并发能力时 |
| 每个提供商最多 key 数 | 8 | `app/src/kernel/modelConfig.ts` | 多 key 只为分摊限流，8 个足够；限制列表长度 | 你需要更多 key 时 |
| 提供商与分组 id | `^[a-z0-9][a-z0-9-]{0,39}$`；保留 `mori` 和 pi 内置的提供商 id | `app/src/kernel/modelConfig.ts` | id 写进会话记录、档案和 `<provider>/<model>`，只用小写字母、数字和 `-` 不会与 `/` 冲突；`mori` 给会话的虚拟模型用，pi 内置 id 会让 pi 把它自己的认证和模型并进来（规格 §4.1） | pi 升级、内置提供商变化时 |
| 排队超时 | 60 秒 | `app/src/kernel/modelTimings.ts` | 对话类请求排队太久不如换模型；只对 `conversation` 类别，探针不限 | 你走查时觉得换得太早或太晚 |
| 429 没有 `Retry-After` 时 key 冷却 | 30 秒 | `app/src/kernel/modelTimings.ts` | 常见限流窗口按分钟计，30 秒内多半恢复一部分，又不至于反复撞限 | 拿到内网端点的限流行为时 |
| 连接失败后提供商不可用 | 30 秒 | `app/src/kernel/modelTimings.ts` | 端点重启、网络抖动多在几十秒内恢复；期间不再白等连接超时 | 拿到内网端点时 |
| 额度错误的关键词 | `insufficient_quota`、`quota`、`billing`、`balance`（不区分大小写，只看 400/403/429 的响应体） | `app/src/kernel/modelFailure.ts` | OpenAI、DeepSeek 等常见服务报额度不足的字样；402 不看关键词 | 遇到新的额度报错原文时 |
| HTTP 404 | 模型不可用，直到提供商或这个模型的配置改变 | `app/src/kernel/modelPool.ts`（不可用记录） | 404 多是模型名写错或服务没部署这个模型，等多久都不会自己好 | 遇到端点用 404 表示临时不可用时 |
| 5xx 原地重试 | 3 次，间隔 2、4、8 秒 | `app/src/kernel/modelTimings.ts` | 与 v0 看到的 pi 自动重试相近（“重试 1/3”），指数退避；5xx 不换模型（proposal：v1 原地重试） | 你走查时 |
| 发出后等第一个有内容的事件 | 120 秒 | `app/src/kernel/modelTimings.ts` | 推理模型、长上下文在内网部署上首字可能很慢；超过这个时长按结果未知处理（§5.7）。每次尝试重新计时，排队和重试不计入 | 拿到内网端点、量过长上下文首字时间时 |
| 超时后已验证取消的模型不可用（`timeout`） | 60 秒 | `app/src/kernel/modelTimings.ts` | 刚超时的模型短时间内多半仍慢，避开一会儿再试 | 你走查时 |
| 超时后不能确认停止的模型等它停下（`held`）/ 读指标确认的间隔 | 2 分钟 / 5 秒 | `app/src/kernel/modelTimings.ts` | 保证同一个请求不同时在两个模型上跑（proposal §8、§12 第 4 条）；2 分钟足够大多数生成被服务端的超时结束；5 秒一次读指标负担很小 | 拿到内网端点、知道它断开后是否停止时 |
| 候选耗尽时最长等 / 重新选的间隔 | 60 秒 / 5 秒 | `app/src/kernel/modelTimings.ts` | 限流冷却多在一分钟内；再久不如告诉你、让你去设置；除了到点和探针结束，每 5 秒再看一次 | 你走查时觉得等得太久或太短 |
| 探针最大输出 / 每一步等第一个有内容的事件 | 256 token（第 9 步 2048）/ 120 秒 | `app/src/kernel/probes.ts`（最大输出）；`app/src/kernel/modelTimings.ts`（时长） | 探针只要短回答；推理模型先输出思考，太小时收不到正文；第 9 步要一个足够长、断开时还在生成的输出；时长同对话请求 | 拿到内网端点时 |
| C 级文本标签连发次数 | 3 | `app/src/kernel/probes.ts` | 连续几次都能解析才算稳定，又不多花请求 | 内网模型的 C 级判定不稳时 |
| 长输入探针的两个长度 | 有效窗口的 50%、90% | `app/src/kernel/probes.ts` | 一半看常用长度，九成看接近上限时是否静默截断；需要你同意后才跑 | 你走查时觉得 token 花得太多 |
| 取消探针等请求数回落 | 5 秒 | `app/src/kernel/modelTimings.ts` | 服务端在断开后几十毫秒到几秒内释放请求（K7 实测几十毫秒）；5 秒内没回落就算不停 | 拿到 vLLM、SGLang、llama.cpp 的内网部署时 |
| 4xx、5xx 响应体最多读 | 64 KB | `app/src/kernel/modelPool.ts` | 分类只需要错误信息；限量防止异常的大响应占内存 | — |
| 区域建议 | 回环地址（127/8、`::1`、`localhost`）→ `local`；10/8、172.16/12、192.168/16、169.254/16、`fc00::/7`、`fe80::/10`、`.local` 与不含点的主机名 → `intranet`；IPv4 映射的 IPv6 地址按其中的 IPv4 判断；其余 → `public` | `app/src/shared/models.ts` `suggestZone`：后台进程（`app/src/kernel/modelConfig.ts`，`models.get` 的 `zoneSuggestions`）与界面（`app/src/renderer/src/components/settings/fields.tsx` 表单的预选、`Notices.tsx` 的 Confirm zone）共用 | 只是预选建议，你确认后才生效；按地址的常见含义划分 | 遇到内网用公网段地址、或公网域名指向内网时 |
| 迁移时 `maxTokens` 缺失 / 不小于窗口 | pi 的默认 16384 / 窗口的一半 | `app/src/kernel/modelMigrate.ts` | 与 pi 自己的默认相同；v1 要求 `maxTokens` 小于窗口，取一半给输入留地方 | 你走查迁移结果时 |
| 新模型表单的 Max output | 16384 与窗口一半中较小的 | `app/src/renderer/src/components/`（模型表单）；2026-10-23 起模型表单只剩 Edit，这条规则用在清单里没报告的值和手填的行（见下面“一键拉取模型”一节） | 同上一行的理由，与迁移一致 | 拿到内网端点时 |
| 兼容选项的标签与说明 | 六个勾选框，标签写端点的情况，下面一行小字写勾了之后 Mori 怎么发请求，例如“Endpoint needs max_tokens instead of max_completion_tokens” / “Older endpoints don’t recognize max_completion_tokens”；全文见规格 §9.1；提供商卡上只列标签 | `app/src/shared/models.ts` `COMPAT_LABELS`、`COMPAT_HINTS`；`app/src/renderer/src/components/settings/fields.tsx` `CompatChecks`（提供商表单与首次启动表单共用） | v0 方案 5.2 要求每项配说明；沿用 english-ui 的英文（[v0/ui-strings.md](../v0/ui-strings.md)），v1 合并时一度只有规格原来的短标签、没有说明，2026-10-21 改回 | 你走查设置页与首次启动时；拿到内网端点时 |
| pi 里的占位 `apiKey` | `mori-pool` | `app/src/kernel/modelCompile.ts` | pi 要有 key 才把提供商当作已配置（K1）；不保密，真正的 key 由模型池写进认证头，占位不会发到服务端（MP-32） | pi 升级时 |
| 重做说明文字、各提示文字 | 规格 §6.1 的重做说明，§9 的界面文字 | `app/src/kernel/modelContext.ts`（重做说明）；`app/src/renderer/src/components/`（提示、阶段行、说明卡、拒绝启动卡） | 重做说明要让新模型知道前半段被隐藏、工作区可能已改；英文给模型读最稳 | 内网模型对英文说明的理解不好时；你走查时 |

## 平行 Agent 与 TaskBoard

来源：[平行 Agent 与 TaskBoard 规格](../specs/parallel-agents-taskboard.md) §15；你不在时定下的选择见 [team-checks.md](team-checks.md)。

| 默认值 | 取值 | 位置 | 理由 | 何时复查 |
| --- | --- | --- | --- | --- |
| 同时运行的 task 与订阅实例上限（每个用户会话） | 4 | `app/src/kernel/boardRoute.ts` | 与每个 key 的默认并发 4 一致；本机与内网的小部署同时跑太多实例只会排队 | 拿到内网端点、知道它的并发时 |
| 写入锁持有范围 | 写 task 的第一个实例开始到这个 task 结束（交给评审、交给结案、等你拿主意、被停止期间都持有） | `app/src/kernel/boardRoute.ts` | 评审不会跑在别的 task 改了一半的代码上；proposal 规则 8 | 你走查时觉得写 task 排队太久 |
| 角色名 | `^[a-z0-9][a-z0-9-]{0,39}$`，不能是 `mori`，不能像编号 `^(t\|r)?[0-9]+$` | `app/src/kernel/roles.ts` | 与提供商 id 同一规则；不与 task、需求编号混淆 | — |
| 文字长度上限 | 标题 80；目标、验收 600；task 说明 1200；交接结论 600；未结事项 10 × 200；Agent 消息 4000；转告 1200；需求结论 1200；角色说明 200 | `app/src/shared/team.ts` | 进工作卡和进展摘要，太长弱模型读不完、界面放不下 | 你走查时 |
| 工作卡上限 / 最近交接 / 消息；超出时留的消息、单条截断、最初原话 | 8000 字符 / 3 棒 / 10 条；3 条、200 字符、2000 字符（用户补充从不截断） | `app/src/kernel/boardText.ts` | 约 2000 token，每次请求都带；用户的话不丢 | 内网小窗口模型上看到效果时 |
| 工作卡的 token 估算 | 字符数 ÷ 4 | `app/src/kernel/boardText.ts` | 给模型层的窗口判断用，粗估即可 | — |
| 立项看到的对话上限 | 12000 字符 | `app/src/kernel/boardText.ts` | 足够看清最近几轮；更早的去掉并注明 | 你走查时 |
| `read_session` 不分页的上限 / 结果摘录 / 投递摘录 | 12000 / 400 / 300 字符 | `app/src/kernel/sessionReader.ts` | 一次读完常见的 task；超过先给目录 | 你走查时 |
| 证据不合格时列出的编号 | 最近 5 个 | `app/src/kernel/evidence.ts` | 告诉模型可以引用哪些 | — |
| 回执里原话的显示长度 | 120 字符 | `app/src/shared/team.ts`（`TEXT_LIMITS.receiptQuote`） | 一行放得下 | 你走查时 |
| 进展摘要交接链每棒 | 结论第一句，≤ 80 字符 | `app/src/shared/team.ts`（`TEXT_LIMITS.chainLine`） | 一眼看完整条链 | 你走查时 |
| `mori.board` 合并发送间隔 | 250 毫秒 | `app/src/kernel/team.ts` | 工具调用很密时不刷屏 | — |
| Agent 消息上限 | 同一需求同一对角色 10 条；不在需求里的发送方按会话 10 条；关闭模式下对话每回合 5 条 | `app/src/kernel/boardRoute.ts` | 防止两个弱模型来回发消息停不下来 | 走查中碰到上限时 |
| 强制填写、强制关闭的格式重试 | 1 次 | `app/src/kernel/handoffForm.ts` | 统一模型提供商 proposal §8“格式错误按格式错误重试”；再错就交结案 | 内网模型的写入等级不稳时 |
| A 级强制填写 | 只在档案 `reasoning.can_disable` 为真时用，这次请求关闭思考 | `app/src/kernel/handoffForm.ts` | 探针第 5 步是在关闭思考时测的 | 遇到能开着思考做强制调用的部署时 |
| `decision` 类别的排队超时 / `task` 类别 | 60 秒 / 不超时 | `app/src/kernel/modelTimings.ts` | 决定排太久不如换模型；task 排队等槽位是常态 | 你走查时 |
| 模型族为空时 | 用 `<provider>/<model>` 当作族 | `app/src/kernel/selector.ts` | 至少同一个模型不给自己评审 | 你给模型都填了族之后 |
| 协作开关的窄栏宽度 | 860px：这一栏不宽于 860px 时开关只显示状态点（约 19px），宽于时显示完整文字；另外显示项目名时面包屑至少留 105px（放不下时收短模型按钮），分屏不宽于 600px 时按钮间距 6px、图标按钮 28px，不宽于 400px 时间距 2px、图标按钮 24px | `app/src/renderer/src/styles/team.css` | 顶栏现有各档（chat.css、models.css、split.css）按没有开关定，每档刚过阈值时只剩约 8–25px（按最宽的英文："Effort: Unavailable"、截在 160px / 120px 的长模型 ID）：`Team: Until done`（约 108px）单栏要宽于约 835px、分屏要宽于约 856px；`Team` 加状态点（约 55px）在 1400 宽右栏打开（690px，模型按钮停在 120px）和 800×600 单栏（740px，模型按钮停在 160px）时也放不下；分屏每栏 280px 时没有开关也只剩约 8px | composer-pickers 合入时（模型、思考强度、权限和上下文用量移到输入框下面，顶栏只剩开关和两个图标按钮，这些都可以去掉或放宽） |
| 给 `conversation`、`decision` 留的槽位 | 每个 key 1 个（`task`、`background` 最多占并发上限 − 1；并发上限为 1 时不留） | `app/src/kernel/modelPool.ts` | 严格优先不打断已经发出的请求；不留的话 4 个 task 占满默认的 4 个槽位，对话和立项等到超时 | 拿到内网端点、知道它的并发时 |
| 命令与界面名 | `/team`、`/team on`、`/team off`、`Team` | `app/src/renderer/src/` | proposal 的暂定名；`/team off` 为派生 | 你走查时 |
| 基座的一句话说明 | `General-purpose agent with the default tools` | `app/src/shared/team.ts`（`BASE_ROLE_DESCRIPTION`） | 基座没有角色文件，`next`、`assignee` 的说明与附加段的“Other roles”要一句话；规格没给 | 你走查时 |
| board.json 改名替换被别的进程挡住时的重试 | 最多 10 次，第 n 次前等 n × 20 毫秒（合计不到 1 秒），只对 EPERM、EACCES、EBUSY | `app/src/kernel/agents.ts`（`writeFileAtomic`） | Windows 上目标文件正被别的进程打开（杀毒、索引）时改名会失败，这一次写出就丢了，要等下一次写入才补上；App 测试每 20 毫秒读一次 board.json 时碰到过 | 你走查时 |
| 程序注入的文字 | 英文（规格附录 A、§8.5） | `app/src/kernel/boardText.ts` | 与 pi 默认的 system prompt 同语言 | 内网模型对英文说明理解不好时 |
| 界面文字 | 规格 §13 | `app/src/renderer/src/` | 英文，Claude 桌面版的写法 | 你走查时 |

## 提示词分层与记忆

来源：[提示词分层与记忆规格](../specs/memory.md) §12；检查记录见 [memory-checks.md](memory-checks.md)。

| 默认值 | 取值 | 位置 | 理由 | 何时复查 |
| --- | --- | --- | --- | --- |
| token 估算 | 中日韩字符每个 1；其余字符数 ÷ 4 向上取整；用量按层分别估算再相加 | `app/src/shared/memory.ts` `estimateMemoryTokens`（界面的用量与后台进程的检查共用） | 不需要分词器，离线可算；中文约一字一 token，英文约四字符一 token；两层分开估，用户级的数在每个项目里相同 | 拿到内网模型的分词器、对过实际 token 数时 |
| 每种的上限 | 500（用户级 + 本项目） | `app/src/shared/memory.ts` `MEMORY_LIMIT`；检查在 `app/src/kernel/memoryRules.ts` | proposal 定的（§5.2）：四种合计约 2000 token，每次请求都带，小窗口模型也放得下 | proposal 改时；内网小窗口模型上看到效果时 |
| 打开增强从哪天读起 | 打开那天；关掉再打开同样从打开那天读起，关着期间的日子不补；片段从 `since` 那天开始截 | `app/src/kernel/enhance.ts`（`since`）；`app/src/kernel/enhanceDays.ts`（片段的起点） | 第一次打开按 proposal §16；关着就是不想让它读，再打开时补读那几天会一下子跑很多 | 你想让它补读关着期间的会话时 |
| 回滚的范围 | 那次修订改过的全部条目；之后又被改过的条目让整次回滚被拒绝；移动回到原层末尾 | `app/src/kernel/memoryRules.ts`（回滚的计划与冲突判断）；`app/src/kernel/memory.ts` | 一次修订是一个整体，只回滚一部分会留下半套改动；不覆盖之后的改动 | 你走查时觉得要能只回滚一部分 |
| 失败后怎么重试 | 下一个时刻、下次启动或现在运行时从没处理完的那天起重跑；不限次数；同一任务排在失败那天之后的日子这一轮不跑 | `app/src/kernel/enhanceDays.ts`（该跑的日子）；`app/src/kernel/enhance.ts`（队列） | 水位不动、按日子顺序跑，不会跳过哪一天；重试只在到点、启动或你点 Run now 时发生，不会连续空转 | 某个项目反复失败、token 花得多时 |
| 子文件夹算不算同一个项目 | 不算，按工作目录精确匹配 | `app/src/kernel/memoryFiles.ts`（项目目录名） | 与 pi 的会话目录一致（proposal §7） | 你想让子文件夹共用上级项目的记忆时 |
| 两个工作目录编码到同一个项目目录 | 以 `project.json` 记下的第一个 `cwd` 为准；另一个工作目录的记忆与增强不读不写，报 `This project’s memory folder belongs to <cwd>.` | `app/src/kernel/memoryFiles.ts`（解析项目目录的函数） | pi 的编码有损，proposal §7 的“精确匹配”与“同 pi”在这里冲突；不把别的项目的条目混进来 | 碰到真实的冲突时 |
| 写用户级时的预算检查 | 对每个有这一种条目的项目逐一检查，任一超出就拒绝；用户级自己超过 500 也拒绝 | `app/src/kernel/memoryRules.ts`（预算检查） | 用户级的每一条都进每个项目的 prompt（proposal §5.2） | 项目多、写用户级常被拒绝时 |
| 每天的时刻 | 04:00，本地时间，每个项目一份（也是日界） | `app/src/shared/memory.ts` `MEMORY_DEFAULTS.dailyTime`；`app/src/kernel/enhance.ts` | proposal §10.1 的例子；这时多半不在用电脑，之前的对话算前一天 | 你走查时（每个项目可在增强设置里改） |
| 改了每天的时刻 | `doneThrough` 退到新的今天的前一天、`since` 不晚于新的今天，靠水位与 `feedbackSeen` 去重 | `app/src/kernel/enhanceDays.ts`（改时刻） | 日界移动后不漏读，也不重复读 | 你走查时 |
| 同一天多个项目的增强顺序 | 按项目 `cwd` 字符串升序 | `app/src/kernel/enhance.ts`（队列） | 确定、可测；proposal 只要求全应用一次一个 | 你想让常用的项目先跑时 |
| 跳过的运行 | `last.status: 'skipped'`，状态行写 `No finished sessions to read`；`doneThrough` 推进，没有修订、不建会话 | `app/src/kernel/enhanceRun.ts`；状态行 `app/src/shared/memory.ts` `enhanceStatusText` | 没有会话可读时不花 token（proposal §10.1），又看得出它跑过 | 你走查时 |
| slug | ASCII 单词小写、`-` 连接、≤ 48 字符；没有时 `<kind>-<YYYYMMDD>-<4 位>`；同一层同名时加 `-2`、`-3` | `app/src/kernel/memoryFiles.ts`；`app/src/shared/memory.ts` `MEMORY_DEFAULTS.slugMax` | 文件名可读、在 Windows 上合法；中文 abstract 不转写 | 你手改记忆文件、觉得名字难认时 |
| 修订 id | `<YYYYMMDD-HHmmss>-<4 位小写字母数字>`（本地时间） | `app/src/kernel/memoryFiles.ts` | 按名字排序就是时间顺序，列表只读文件名；后缀防同一秒写两次 | — |
| 修订记录的围栏 | 至少 `~~~~`，比原文里最长的纯波浪号行多一个；`<围栏>before` / `<围栏>after` / `<围栏>` | `app/src/kernel/memoryFiles.ts` | detail 里有代码块也不冲突；原文逐字保存，回滚逐字恢复 | — |
| 记忆页修改、移动的修订说明 | `Edited on the Memory page`、`Moved to user level`、`Moved to this project` | `app/src/kernel/memory.ts` | 在记忆页改时不另填原因；移动的说明是按钮文字的过去式 | 你走查时 |
| memory 工具修订标题里的 abstract | 前 60 字符 | `app/src/shared/memory.ts` `MEMORY_DEFAULTS.titleAbstractMax` | 修订列表一行放得下 | 你走查时 |
| 找不到条目时列出的候选 | 最多 10 条，每条 `<layer>/<id>: <abstract>` | `app/src/shared/memory.ts` `MEMORY_DEFAULTS.candidatesMax`；`app/src/kernel/memoryRules.ts`（条目匹配） | 让模型下一次照着写对，又不把整份列表塞进工具结果 | 内网模型常找不到条目时 |
| 字段长度 | abstract 1–200 字符（一行）；detail ≤ 4000；note ≤ 600；quote ≤ 600；依据 1–10 项；Notes ≤ 4000 | `app/src/shared/memory.ts` `MEMORY_DEFAULTS`（后台进程、memory 工具的 schema 与记忆页的表单共用）；检查在 `app/src/kernel/memoryRules.ts` | abstract 每次请求都带，要短；detail 只给你和增强任务读，可以长一些；防异常的大输入 | 你走查时；内网模型写的条目常被拒绝时 |
| 修订列表每次最多 | 200 条 | `app/src/shared/memory.ts` `MEMORY_DEFAULTS.revisionsMax`；`app/src/kernel/memory.ts` | 只读文件名与 frontmatter，一次 200 条读得快 | 你走查时觉得要看更早的修订 |
| 会话名 | pi 的会话名，没有时第一条用户消息的前 60 字符 | `app/src/shared/memory.ts` `MEMORY_DEFAULTS.sessionTitleMax`；`app/src/kernel/enhanceRun.ts`、`app/src/kernel/memoryTool.ts` | 同侧栏的写法，依据行和第一条消息里认得出是哪个会话 | 你走查时 |
| token 数 | 增强会话与它 TaskBoard 目录下全部实例会话文件，关闭后按物理行读出，按 `getSessionStats` 的算法累加 `input + output` | `app/src/kernel/enhanceRun.ts` | 实例在运行中途已关闭，不能对它们调 `getSessionStats`，只能从文件读 | pi 升级、`getSessionStats` 的算法变化时 |
| 增强会话的调度类别 | `background` | `app/src/kernel/enhanceRun.ts` | 统一模型提供商规格 §8.2：订阅与定时归 `background`，不占给对话留的槽位 | 你走查时觉得增强跑得太慢 |
| 新会话提示、增强状态行（关、排着、全部跳过）、设置对话框的说明、离开编辑的确认框标题 | 规格 §10 标“临时”的文字 | `app/src/shared/memory.ts`（`memoryNoticeText`、`enhanceStatusText`）；`app/src/renderer/src/components/Memory*.tsx` | 没有 Claude 桌面版对应，规格定的 | 你走查时 |
| 程序注入的文字 | 英文（规格附录） | `app/src/kernel/memoryText.ts` | 与 pi 默认的 system prompt 同语言 | 内网模型对英文说明理解不好时 |
| 看不见的会话遇到还没有信任决定的项目 | 按不信任，不加载项目的扩展与技能，不询问 | `app/src/kernel/sessions.ts`（startHeadless） | 没有人回答信任询问；v0 的规则是不经询问不加载项目扩展 | 你走查增强、需要增强用项目扩展时 |
| 增强运行中关掉这个项目的增强 | 正在跑的那一次立即停止、记为失败（`Enhancement was turned off`），水位不动 | `app/src/kernel/enhance.ts` | 关掉就是不要它再跑；没读完的部分下次打开后照 `since` 的规则处理 | 你走查时 |
| 协作模式的增强运行里有需求等你拿主意 | 会话与 Team 都空闲时算结束、修订 `done`，需求留在 TaskBoard 上 | `app/src/kernel/enhanceRun.ts` | 看不见的会话没人回答，等下去就永远不结束 | 你走查协作模式的增强时 |
| `agent` 调用方的 `save`、`update` 要带 `quote` | 必填 | `app/src/kernel/memoryRules.ts`（toolFieldError）、`app/src/kernel/memoryText.ts`（说明与 Correct form） | proposal §8.1 的依据是你的原话，记下的条目算“你说的” | 你走查对话里记一条、真实模型常漏写原话时 |
| 在记忆页改一条“它学的” | 改后为 `You said`，之后增强不能再改它 | `app/src/kernel/memory.ts` | proposal §4 把你手写的算“你说的”；要退回可以回滚这次修改 | 你走查记忆页时 |

## 一键拉取模型

来源：[一键拉取模型规格](../specs/model-discovery.md) §11，另加清单的默认勾选（§6.2）与列表地址的试法（§3.2）；位置是规格 §2 定下的代码落点，时长放在 `app/src/kernel/modelTimings.ts`。
检查记录见 `discovery-checks.md`（实现时新建）。

| 默认值 | 取值 | 位置 | 理由 | 何时复查 |
| --- | --- | --- | --- | --- |
| 每个发现请求的时限（连接到读完响应体） | 15 秒；探针第 0 步的每个请求同样用它（原来是 120 秒的探针步时限，规格 §7.1） | `app/src/kernel/modelTimings.ts` | 发现只读列表和详情，不等模型生成；连不上的地址不让你在表单前干等。列表请求超时为 `unreachable`（“Timed out after 15s”），详情请求超时只按失败（规格 §4.2） | 拿到内网端点、量过列表与详情接口的响应时间时；Ollama 逐个读 `/api/show` 常超时时 |
| 每个响应体最多读 | 8 MB | `app/src/kernel/modelDiscover.ts` | 列表带描述、价格等字段时可能较大；限量防止异常的大响应占内存。超过时列表请求按 `invalid`（“The model list is larger than 8 MB.”），详情请求按失败（规格 §5.3） | 遇到合法的列表超过 8 MB 时 |
| 服务原文最多保留 | 2000 字 | `app/src/kernel/modelDiscover.ts`（`listError.detail`） | 原文只用来看懂为什么拿不到列表；服务回一整页 HTML 时不撑满表单 | 你走查列表错误时 |
| 列表最多条数 | 1000；超过时只取前面的，`truncated: true`，清单写 “Showing the first 1,000 models.” | `app/src/kernel/discoverRead.ts`（截断规则） | 清单是用来勾选的；网关、OpenRouter 一次列出几十到几百个（proposal §2），1000 够用，再多也看不过来 | 遇到超过 1000 个模型、要的模型排在后面的网关时 |
| Anthropic 形状列表最多页数 | 5（每页 `limit=1000`） | `app/src/kernel/modelDiscover.ts`（按 `has_more` 或 `hasMore`、`after_id` 翻页，规格 §3.2） | 兼容服务每页给的可能比 `limit` 少，要翻几页才拿全；页数上限防止翻页停不下来 | 遇到要翻 5 页以上的 Anthropic 兼容列表时 |
| 百炼原生列表每页 / 最多页数 | 100 / 10 | `app/src/kernel/modelDiscover.ts`（`page_no`、`page_size`） | 原生列表分页、默认每页 20（proposal §14），每页 100 少翻几次；10 页 1000 个与列表的条数上限一致 | 用真实 key 核对 `dashscope.aliyuncs.com` 上的原生列表与 `page_size` 的上限时（proposal §14 未验证） |
| 对同一个 origin 同时进行的读取请求 | 4；命令的发现、探针第 0 步、读版本合计，Ollama 的 `/api/show` 也在其中；多出来的排队（规格 §5.3） | `app/src/kernel/modelDiscover.ts` | 发现不经模型池、不占槽位，要自己限并发（规格 §9）；一次加入多个模型时各自的第 0 步、Ollama 逐个 POST `/api/show` 都打在同一个服务上，4 个不压满本机或内网的服务，又不至于等太久 | 拿到内网端点、量过详情接口与 `/api/show` 的耗时时 |
| Ollama `/api/show` 最多读的模型数 | 100；超过的模型不读 `/api/show`，窗口按 `/api/ps`、`/api/tags` 能读到的 | `app/src/kernel/modelDiscover.ts` | 每个模型要一个 POST `/api/show`（读 Modelfile 的 `num_ctx`，0.30.0 以前还读 `capabilities`，规格 §4.2）；按每个 origin 4 个同时进行，模型再多时要等很久；超过 100 个的只用列表、`/api/tags`、`/api/ps` 已有的 | 拿到内网 Ollama、量过 `/api/show` 的耗时时 |
| 清单显示过滤框的行数 | 超过 20 行，手填的行也算（占位 “Filter models”，按 id 子串过滤，不分大小写，不改勾选；被藏起来的勾选行照样加入，规格 §6.2） | `app/src/renderer/src/components/settings/Checklist.tsx` | 20 行以内一屏看得完；再多时按 id 找比滚动快 | 你走查清单时 |
| `anthropic-version` 请求头 | `2023-06-01` | `app/src/kernel/discoverRead.ts`（列表地址的计划） | Anthropic 的接口要求带这个头，读列表也一样；合成端点的 `anthropic` 形状同样要求它（规格 §13.1） | Anthropic 发布新的 API 版本、或兼容服务拒绝这个值时 |
| 没报告时的窗口 / 输出上限 | 128000 / 16384 与窗口一半中较小的；清单里标 “Not reported” | `app/src/shared/models.ts`（`UNREPORTED_CONTEXT_WINDOW`、`unreportedMaxTokens`，2026-10-23 实现时放在这里，一份规则两边用）：`app/src/kernel/discoverRead.ts`（读一行、§4.3 的最后检查）与清单里手填的行和改窗口时（`app/src/renderer/src/components/settings/fields.tsx`）都用它 | 同模型层规格 §12（pi 的默认、原来新模型表单的 Max output）；不查 pi 的模型目录、不按名字猜（proposal §12 第 2 条），由探针与长输入测试再核实 | 同模型层“新模型表单的 Max output”一行；拿到内网端点时 |
| 名称 | 主机名，端口不是协议默认端口时加 `:<端口>`（例如 `api.deepseek.com`、`10.0.0.5:8000`） | `app/src/kernel/discoverRead.ts` | 主机名就认得出是哪个服务；同一台机器上的几个服务靠端口区分；拉取后可以改 | 你走查时 |
| 探针代价的说明 | “Each model is verified with up to 13 short requests.”（自动探针第 1–7 步最多 13 个请求） | `app/src/renderer/src/components/settings/`（Add provider 和卡上清单的底部，Add 按钮上方；首次启动表单在 Test connection 上方，规格 §6.6） | proposal §12 第 5 条：加入的模型全部自动跑探针，清单底部写明代价；在公网云上会花一点额度 | 探针步骤变化（`PROBE_SUITE` 改版）时 |
| 清单的默认勾选 | 服务报告是聊天模型（`chat` 为真）的勾上，报告不是的不勾；不报告类型（`chat` 为 null）时，能加入的行只有一行就勾上，否则都不勾；Added、不能加入的行不勾 | `app/src/renderer/src/components/settings/Checklist.tsx` | proposal 已定（§12 第 1、4 条）：只按服务报告的类型判断，不按名字猜；OpenAI 这类不报告类型的列表里混着 embedding、语音和图片模型，全勾会加入不能对话的模型，所以只有一个时才勾，其余用 Select all | 你走查清单、常要手动 Select all 或取消勾选时 |
| 列表地址最多试 3 次 | 没有 Anthropic 提示时最多 2 个（`<base>/models`；base 不以 `/v<数字>` 结尾时再试 `<base>/v1/models`）；有 Anthropic 提示时最多 3 个（`<base>/v1/models?limit=1000`、前缀 + `/models`、前缀 + `/v1/models`；主机是 `api.anthropic.com` 时只有第一个）；已有提供商不整理地址：`openai-*` 只试 `<baseUrl>/models`，`anthropic-messages` 同有 Anthropic 提示时的三个（前缀取 `baseUrl` 路径里 `anthropic` 那一段之前的部分；主机是 `api.anthropic.com` 或路径里没有这一段时只试第一个）；拿到列表、401/403 或连接失败、超时即停 | `app/src/kernel/discoverRead.ts`（列表地址的计划） | 补 `/v1`、去掉 `anthropic` 那一段对应 proposal §5.1、§5.3 写的两种常见填法（一键拉取模型 proposal 要求的功能，不算 fallback）；不再往下猜更多路径；认证失败和连不上时换地址也没用 | 遇到列表在别的路径上的服务时 |
