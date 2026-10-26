# 临时默认值（v1）

实现时需要一个值、但还没有经过你确认的地方都登记在这里。每一项都是“临时默认值”，拿到依据后再定。
第一张表是模型层，来源：[统一模型提供商构建规格](../specs/model-providers.md) §12；位置是规格 §2 定下的代码落点，时长都集中在 `app/src/kernel/modelTimings.ts`。
后面的平行 Agent 与 TaskBoard、提示词分层与记忆、一键拉取模型、文件系统、收尾检查各成一节，来源写在各节开头。
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
| 区域建议 | 回环地址（127/8、`::1`、`localhost`）→ `local`；10/8、172.16/12、192.168/16、169.254/16、`fc00::/7`、`fe80::/10`、`.local` 与不含点的主机名 → `intranet`；IPv4 映射的 IPv6 地址按其中的 IPv4 判断；其余 → `public` | `app/src/shared/models.ts` `suggestZone`：后台进程（`app/src/kernel/modelConfig.ts`，`models.get` 的 `zoneSuggestions`）与界面（`app/src/renderer/src/components/settings/Checklist.tsx` `prefillDraft`：拉取后按 Base URL 框预选；`fields.tsx` `emptyProvider`：拉取前的初值；`Notices.tsx` 的 Confirm zone）共用 | 只是预选建议，你确认后才生效；按地址的常见含义划分 | 遇到内网用公网段地址、或公网域名指向内网时 |
| 迁移时 `maxTokens` 缺失 / 不小于窗口 | pi 的默认 16384 / 窗口的一半 | `app/src/kernel/modelMigrate.ts` | 与 pi 自己的默认相同；v1 要求 `maxTokens` 小于窗口，取一半给输入留地方 | 你走查迁移结果时 |
| 新模型表单的 Max output | 16384 与窗口一半中较小的 | `app/src/renderer/src/components/`（模型表单）；2026-10-23 起模型表单只剩 Edit，这条规则用在清单里没报告的值和手填的行（见下面“一键拉取模型”一节） | 同上一行的理由，与迁移一致 | 拿到内网端点时 |
| 兼容选项的标签与说明 | 六个勾选框，标签写端点的情况，下面一行小字写勾了之后 Mori 怎么发请求，例如“Endpoint needs max_tokens instead of max_completion_tokens” / “Older endpoints don’t recognize max_completion_tokens”；全文见规格 §9.1；提供商卡上只列标签 | `app/src/shared/models.ts` `COMPAT_LABELS`、`COMPAT_HINTS`；`app/src/renderer/src/components/settings/fields.tsx` `CompatChecks`（提供商表单与首次启动表单共用） | v0 方案 5.2 要求每项配说明；沿用 english-ui 的英文（[v0/ui-strings.md](../v0/ui-strings.md)），v1 合并时一度只有规格原来的短标签、没有说明，2026-10-21 改回 | 你走查设置页与首次启动时；拿到内网端点时 |
| pi 里的占位 `apiKey` | `mori-pool` | `app/src/kernel/modelCompile.ts` | pi 要有 key 才把提供商当作已配置（K1）；不保密，真正的 key 由模型池写进认证头，占位不会发到服务端（MP-32） | pi 升级时 |
| 重做说明文字、各提示文字 | 规格 §6.1 的重做说明，§9 的界面文字 | `app/src/kernel/modelContext.ts`（重做说明）；`app/src/renderer/src/components/`（提示、阶段行、说明卡、拒绝启动卡） | 重做说明要让新模型知道前半段被隐藏、工作区可能已改；英文给模型读最稳 | 内网模型对英文说明的理解不好时；你走查时 |
| 思考关不掉的模型在探针里用的强度（2026-10-24 补） | `medium`（同第 1 步与第 4 步的回传检查），按哪一份判定用它分两组（规格 §7.7）：第 1–7 步（一组自动探针）都在一份没有“没有 Off”标记的模型副本上发，**这一组**第 2 步判出 `off_refused` 时第 3、4、6、7 步用 `medium`、第 5 步不适用（第 7 步照第 6 步的结果决定跑不跑），没判出时同原来（`off`），不看档案里存的；第 8、9 步（需要你同意，单独一组）用编译后的模型，按档案里存的 `off_refused` 选，为真时用 `medium`，否则同原来；第 2 步照旧分别用 `off` 和 `medium` | `app/src/kernel/probes.ts` | 这类模型关闭思考被服务拒绝（400），探针只能开着思考测；用第 1 步和回传检查已经在用的 `medium`，不另加一个值。第 1–7 步按本组第 2 步而不按档案：已经标记过的模型点 Verify 时第 2 步重新测，这一次判出能关闭时第 3–7 步也确实关闭思考；第 8、9 步不跑第 2 步，这时编译后的模型与档案一致，只能按档案。2026-10-24 在 OpenRouter 上实测（[models-checks.md](models-checks.md)“思考关不掉的模型：实测”）：`recursive/flint-v1.0:free` 在 `medium` 下第 3、4、6 步通过、第 7 步连发 3 次都通过，`liquid/lfm-2.5-2.6b:free` 第 3、4、6 步通过；`medium` 不在模型列出的强度里时 OpenRouter 也不拒绝（`z-ai/glm-5.3-flash` 列 `[max, high, low]`，收 `medium` 是 200、正常回答） | 拿到别的服务（Anthropic、百炼、MiniMax、内网部署）上必须思考的模型时；`medium` 下探针常停在输出上限时 |
| 测试连接的思考强度（2026-10-24 补） | 勾了 Supports thinking 的模型带 `medium`（同探针第 1 步），没勾的不带（规格 §7.7） | `app/src/kernel/config.ts`（`testConnection`） | 不带强度时 pi-ai 在 OpenRouter、DeepSeek、z.ai、Together 的地址和 `openai-responses`、`anthropic-messages` 上写成明确的“关闭思考”，必须思考的模型回 400，第一次探测之前的测试连接就失败；带 `medium` 不用等档案。2026-10-24 实测（[models-checks.md](models-checks.md)“思考关不掉的模型：实测”）：两个必须思考的模型用 `medium` 问第 1 步那一句都是 200、回答“ready”，关闭思考（`reasoning: { effort: "none" }`）时都回 400 `Reasoning is mandatory for this endpoint and cannot be disabled.` | 测试连接因为开着思考明显变慢时；拿到别的服务上必须思考的模型时 |
| 探针回复停在输出上限、只有思考（2026-10-24 补） | 回复因输出上限停下（`stopReason` 为 `length`），没有正文也没有工具调用、只有思考时，这一步按出错处理，说明“Stopped at the probe output limit before answering”；对所有模型的第 1–9 步；不判为不通过，第 8 步也不因此记 `silent`；探针最大输出仍是 256 token（规格 §7.7） | `app/src/kernel/probes.ts` | 开着思考时 256 token 可能全花在思考上，这不是模型做不到：判为不通过会把能用的模型标成失败，第 8 步还会误记成静默截断；按出错处理，说明看得出是输出上限。2026-10-24 实测（[models-checks.md](models-checks.md)“思考关不掉的模型：实测”）：`liquid/lfm-2.5-2.6b:free` 在 `medium` 下第 7 步连发 3 次都停在 256 token（`finish_reason: length`），只有约 900 字思考、没有正文；它第 6 步已通过（B 级），真实探测时第 7 步不跑，所以最大输出维持 256，不为这一种情况调大 | 内网或别的服务上的思考模型常因此出错、需要调大探针最大输出时 |

## 平行 Agent 与 TaskBoard

来源：[平行 Agent 与 TaskBoard 规格](../specs/parallel-agents-taskboard.md) §15；你不在时定下的选择见 [team-checks.md](team-checks.md)。

| 默认值 | 取值 | 位置 | 理由 | 何时复查 |
| --- | --- | --- | --- | --- |
| 同时运行的 task 与订阅实例上限（每个用户会话） | 4 | `app/src/kernel/boardRoute.ts` | 与每个 key 的默认并发 4 一致；本机与内网的小部署同时跑太多实例只会排队 | 拿到内网端点、知道它的并发时 |
| 写入锁持有范围 | 写 task（`limits.write` 不是 false 的 task）的第一个实例开始到这个 task 结束（交给评审、交给结案、等你拿主意、被停止期间都持有）（2026-10-26 注：见 file-system-permissions.md §8.7） | `app/src/kernel/boardRoute.ts` | 评审不会跑在别的 task 改了一半的代码上；proposal 规则 8 | 你走查时觉得写 task 排队太久 |
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
| 协作开关的窄栏宽度 | 600px：这一栏不宽于 600px 时开关只显示状态点（约 19px），宽于时显示完整文字（2026-10-22 composer-pickers 合入前是 860px，另有面包屑至少 105px、分屏窄栏收紧按钮间距和图标按钮两处，合入后去掉） | `app/src/renderer/src/styles/team.css` | 合入后顶栏只有“项目名 › 会话名”、开关、右栏开关和分屏时的“Close pane”。按很长的会话名、项目名收到 40px 算：完整的 `Team: Until done`（App 里量到 105px）在 601px 分屏还给会话名留约 315px，和 1280 宽分屏只有状态点时（307px）差不多；不宽于 600px 时只有状态点，460px 258px、280px 173px（App 里量到的）。与输入框下面一行发送组只剩图标的一档相同 | 你走查时觉得完整文字该更早或更晚收起，或想要“Team ●”这种带字的窄样子（规格原稿的写法） |
| 给 `conversation`、`decision` 留的槽位 | 每个 key 1 个（`task`、`background` 最多占并发上限 − 1；并发上限为 1 时不留） | `app/src/kernel/modelPool.ts` | 严格优先不打断已经发出的请求；不留的话 4 个 task 占满默认的 4 个槽位，对话和立项等到超时 | 拿到内网端点、知道它的并发时 |
| 命令与界面名 | `/team`、`/team on`、`/team off`、`Team` | `app/src/renderer/src/` | proposal 的暂定名；`/team off` 为派生 | 你走查时 |
| 基座的一句话说明 | `General-purpose agent with the default tools` | `app/src/shared/team.ts`（`BASE_ROLE_DESCRIPTION`） | 基座没有角色文件，`next`、`assignee` 的说明与附加段的“Other roles”要一句话；规格没给 | 你走查时 |
| board.json、AGENTS.md、model-config.json、模型档案改名替换被别的进程挡住时的重试 | 最多 10 次，第 n 次前等 n × 20 毫秒（合计不到 1 秒），只对 EPERM、EACCES、EBUSY | `app/src/kernel/renameRetry.ts`（`renameReplacing`） | Windows 上目标文件正被别的进程打开（杀毒、索引）时改名会失败，这一次写出就丢了，要等下一次写入才补上；App 测试每 20 毫秒读一次 board.json 时碰到过，设置页连着上移、删除 key 时 model-config.json 也碰到过（2026-10-22） | 你走查时 |
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
检查记录见 [discovery-checks.md](discovery-checks.md)。

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
| 没报告时的窗口 / 输出上限 | 128000 / 16384 与窗口一半中较小的；清单里标 “Not reported” | `app/src/shared/models.ts`（`UNREPORTED_CONTEXT_WINDOW`、`unreportedMaxTokens`，2026-10-23 实现时放在这里，一份规则两边用）：`app/src/kernel/discoverRead.ts`（读一行、§4.3 的最后检查）与界面都用它：清单里手填的行（`app/src/renderer/src/components/settings/Checklist.tsx` `enteredRow`）、改窗口时（`Checklist.tsx` `followWindow` 经 `fields.tsx` `defaultMaxOutput`）、模型行窗口提示的 Use（`settings/ModelRows.tsx` `sizeHints`，规格 §8） | 同模型层规格 §12（pi 的默认、原来新模型表单的 Max output）；不查 pi 的模型目录、不按名字猜（proposal §12 第 2 条），由探针与长输入测试再核实 | 同模型层“新模型表单的 Max output”一行；拿到内网端点时 |
| 名称 | 主机名，端口不是协议默认端口时加 `:<端口>`（例如 `api.deepseek.com`、`10.0.0.5:8000`） | `app/src/kernel/discoverRead.ts` | 主机名就认得出是哪个服务；同一台机器上的几个服务靠端口区分；拉取后可以改 | 你走查时 |
| 探针代价的说明 | “Each model is verified with up to 13 short requests.”（自动探针第 1–7 步最多 13 个请求） | `app/src/renderer/src/components/settings/`（Add provider 和卡上清单的底部，Add 按钮上方；首次启动表单在 Test connection 上方，规格 §6.6） | proposal §12 第 5 条：加入的模型全部自动跑探针，清单底部写明代价；在公网云上会花一点额度 | 探针步骤变化（`PROBE_SUITE` 改版）时 |
| 清单的默认勾选 | 服务报告是聊天模型（`chat` 为真）的勾上，报告不是的不勾；不报告类型（`chat` 为 null）时，能加入的行只有一行就勾上，否则都不勾；Added、不能加入的行不勾 | `app/src/renderer/src/components/settings/Checklist.tsx` | proposal 已定（§12 第 1、4 条）：只按服务报告的类型判断，不按名字猜；OpenAI 这类不报告类型的列表里混着 embedding、语音和图片模型，全勾会加入不能对话的模型，所以只有一个时才勾，其余用 Select all | 你走查清单、常要手动 Select all 或取消勾选时 |
| 列表地址最多试 3 次 | 没有 Anthropic 提示时最多 2 个（`<base>/models`；base 不以 `/v<数字>` 结尾时再试 `<base>/v1/models`）；有 Anthropic 提示时最多 3 个（`<base>/v1/models?limit=1000`、前缀 + `/models`、前缀 + `/v1/models`；主机是 `api.anthropic.com` 时只有第一个）；已有提供商不整理地址：`openai-*` 只试 `<baseUrl>/models`，`anthropic-messages` 同有 Anthropic 提示时的三个（前缀取 `baseUrl` 路径里 `anthropic` 那一段之前的部分；主机是 `api.anthropic.com` 或路径里没有这一段时只试第一个）；拿到列表、401/403 或连接失败、超时即停 | `app/src/kernel/discoverRead.ts`（列表地址的计划） | 补 `/v1`、去掉 `anthropic` 那一段对应 proposal §5.1、§5.3 写的两种常见填法（一键拉取模型 proposal 要求的功能，不算 fallback）；不再往下猜更多路径；认证失败和连不上时换地址也没用 | 遇到列表在别的路径上的服务时 |

## 文件系统

来源：[文件系统构建规格](../specs/file-system.md) §17；§6–§10（路径闸、命令分析与 `.work`、收窄、你不在、`ask_user_question`）的正文在它的续篇 [file-system-permissions.md](../specs/file-system-permissions.md)。
按规格的节分组，每一行在对应节的正文里写了用在哪里；位置照规格 §17 原样：文件相对 `app/src/`，`tests/` 相对 `app/`，只写文件名、函数名或界面部位的，文件见规格 §2 的表。
规格 §0“写规格时定的”八条是负责人定的，不在这里。检查记录将写在 `docs/v1/fs-checks.md`（实现时新建，规格 §18）。

| 默认值 | 取值 | 位置 | 理由 | 何时复查 |
| --- | --- | --- | --- | --- |
| **§3–§5 git、快照与 Rewind** | | | | |
| git 最低版本 | 2.32 | `kernel/git.ts` | `GIT_CONFIG_GLOBAL` 从 2.32 起（Git for Windows RelNotes 2.32.0），内部仓库的隔离靠它（§3.3、§4.1）；`rev-parse --path-format=absolute`（2.31）、`restore`（2.23）、`--pathspec-from-file`（2.26）都更早；本机 2.55 | 遇到装着 2.32 以前 git 的机器时；要用更新的 git 选项时 |
| 找 git 的位置 | `PATH` 里每个目录下的 `git.exe`，然后 `C:\Program Files\Git\cmd\git.exe` | `kernel/git.ts` | Mori 不自带 git；Git for Windows 默认装在这里，pi 找 Git Bash 也看 Program Files（`app/node_modules/@earendil-works/pi-coding-agent/dist/utils/shell.js:69-73`） | 遇到 git 装在别处的机器时 |
| 找 git 的环境变量 | `MORI_GIT_PATH`：有值时只试这一个路径，文件不存在为 `missing` | `kernel/git.ts` | App 测试要能做出没装 git（开发机都装着 Git for Windows）；照 `MORI_USER_DATA` 的写法，只给测试用 | — |
| 没找到 git 时再找 | 每次 `workspace.status` 命令（只看文件是否存在） | `kernel/git.ts` | 装好 git 后点 Refresh 就能用；别处不重找，不起多余的进程 | 你走查时觉得装好 git 后还要点 Refresh 不方便时 |
| git 进程超时 | `--version` 5 秒；`rev-parse`、`status`、给界面的 `diff` 10 秒；快照与恢复里每个进程 120 秒；删除会话的 `prune` 300 秒 | `kernel/git.ts` | status 实测 0.13 秒，10 秒足够大仓库；快照的第一次 `add` 在 2 万个文件时约 50 秒（u-a8 按 3 万个 76 秒推算），120 秒留余量 | 量过公司仓库的快照耗时（FS-21）时；大仓库上 git 常超时时 |
| git 输出上限 | `status` 4 MB；其他 16 MB；stderr 64 KB | `kernel/git.ts` | 限内存；status 默认把未跟踪目录收成一行，4 MB 约 5 万条 | 大仓库的 git 状态常被截断时 |
| git 状态列出的条数 | 500 | `kernel/workspace.ts` | 右栏看得过来；`total` 给出全部条数 | 你走查时觉得右栏列得太多或太少 |
| 刷新去抖 | 500 毫秒（只对工具执行完这一个时机） | `kernel/workspace.ts` | 一连串命令只读一次；其余时机是你的操作或一轮结束，立即读 | 你走查时觉得 git 状态跟得太慢，或一连串命令时刷新太勤 |
| 认出“不是 git 仓库” | 退出码 128 且 stderr 含 `not a git repository`（`LC_ALL=C`） | `kernel/workspace.ts` | 退出码分不出“不是仓库”和 `dubious ownership` 等错误；固定英文提示后按原文判断 | git 升级、这句提示的原文变化时 |
| 快照目录的环境变量 | `MORI_SNAPSHOTS_DIR` | `main/kernel-process.ts` | 测试要能改；照 `MORI_USER_DATA` 的写法 | — |
| 内部仓库的归属 | 内部仓库里写 `mori.json { cwd }`；`cwd` 不同（两个工作路径的 `projectDirName` 编码相同）时这个工作路径的快照为 `off`，原因 `Snapshots are off for this folder: its snapshot folder belongs to <cwd>.` | `kernel/snapshots.ts` | 编码会让 `C:\a-b` 与 `C:\a\b` 落进同一个目录；共用内部仓库会把别的文件夹的文件当成改动、Rewind 恢复错 | 真遇到撞名时 |
| 内部仓库的提交身份与消息 | `Mori <mori@localhost>`、`Mori snapshot`，没有父提交 | `kernel/snapshots.ts` | 隔离配置后没有身份 git 会拒绝；没有父提交，整理时旧的树不被链着留下 | — |
| 隔离的全局配置 | `<快照目录>\gitconfig`，只有 `[safe] directory = *` | `kernel/snapshots.ts` | 较早的 git 只在 system、global 配置里认 `safe.directory`，写在全局文件里各版本都认；不读你的全局与系统配置（u-a8 的 LFS 过滤器、autocrlf） | git 升级、`safe.directory` 的规则变化时 |
| 内部仓库的 `info/attributes` | `* -text !eol -filter -ident -working-tree-encoding` | `kernel/snapshots.ts` | 按字节存、按字节恢复，`.gitattributes` 的换行与过滤不改恢复出来的文件 | 遇到恢复出来的文件与原来的字节不同时 |
| 排除的生成 | 问你的 git（`ls-files --others --ignored --exclude-standard --directory`），写成锚定规则 | `kernel/timeline.ts`（生成与转义）、`kernel/snapshots.ts` | 工作路径是子文件夹时复制 `.gitignore`、`info/exclude`、全局排除要改写锚定规则；问 git 与 git status 完全一致，实测 0.13 秒 | 量过公司仓库的快照耗时（FS-21）时；遇到快照的排除与 git status 不一致时 |
| `.work/`、`.mori/worktrees/` 的排除 | 只在工作路径根（`/.work/`、`/.mori/worktrees/`） | `kernel/timeline.ts` | 别的工作路径的 `.work` 有自己的 `.gitignore`；不误排除你自己叫 `.work` 的子目录 | 遇到别的工作路径的 `.work`、worktree 被拍进快照时 |
| 非仓库的默认排除写法 | `node_modules/` 等不带前导 `/`，任何一层 | `kernel/timeline.ts` | 名单是 proposal 的；这些目录常在子项目里 | 遇到你自己的目录叫这些名字、被误排除时 |
| 已进内部仓库、后来被忽略的文件 | 继续跟踪，不清理 | `kernel/snapshots.ts` | git 对已跟踪文件不看忽略规则；清理要每张多一次调用 | 内部仓库因此明显变大时 |
| 大文件说明 | 列出前 20 个 | `kernel/snapshots.ts`、右栏 | 说明哪些文件 Rewind 不会恢复；限长度 | 你走查时 |
| 嵌套仓库的说明 | 树变了时 `git ls-tree -r -z` 找 mode 160000 的条目，`nested` 最多 20 个、`nestedTotal` 记全部；This session 上方一行 `Changes inside nested repositories aren’t tracked: <路径>, <路径>`，多于 20 个时接 ` and <n> more` | `kernel/snapshots.ts`、右栏 | 写规格时定的第 8 条只说列出这些路径；条数上限同大文件说明 | 你走查时 |
| 文件数暂停之后 | 每个快照点重新数，降到上限内自动恢复，从新的基准开始 | `kernel/snapshots.ts` | proposal 只说暂停、说明原因；加了 `.gitignore` 就恢复，不另加按钮 | 你走查时觉得要一个手动恢复的按钮时 |
| 快照超时 | 某个 git 进程超过 120 秒：这一张 `error`（`a snapshot step took longer than 2 minutes`），下一个快照点续做；同一工作路径连续 3 张都超时才暂停到后台进程重启 | `kernel/snapshots.ts` | 分批后超时只丢一批，续做能完成；连续 3 次才停，避免每次运行开始都白等 120 秒 | 量过公司仓库的快照耗时（FS-21）时；快照常超时时 |
| 分批加入的条数 | 新文件多于 2000 个时每批 2000 条，一批一个 git 进程，每批都写进 index | `kernel/snapshots.ts` | 一次 `add -A` 被结束时一点进度都不留；u-a8 实测 3 万个文件 76 秒，2000 个一批远在 120 秒内 | 量过公司仓库的快照耗时（FS-21）时；分批之后仍常超时时 |
| 嵌套工作路径的 overlap | 包含或被包含的工作路径上同时有运行时记 `overlap: true` | `kernel/snapshots.ts` | proposal §13 第 17 条只写同一文件夹；嵌套文件夹的会话写的文件同样进这个会话的快照，不标就会在 Rewind 时不问被覆盖 | 你走查嵌套文件夹里的会话时 |
| 增强会话与它的实例 | 不拍快照，不进 `active` | `kernel/snapshots.ts` | 没有右栏、不能 Rewind（记忆规格 §9.6）；它们的改动按别人改的算：你空闲时改的不记，在这个会话最近一张快照之后改的 Rewind 时列为 `changed`；和你的会话同时运行时改的记进那一段、不标 `overlap`（同外部程序改的） | 你走查增强、看到它的改动记进你的会话时 |
| 由 custom 消息开始的运行 | 没有起始消息、没有 `run` 记录；改动归你最近的消息 | `kernel/timeline.ts` | `before_agent_start` 的 `messageType: 'custom'`；不这样，运行中插话的消息会被当成起始消息 | pi 升级、`before_agent_start` 的 `messageType` 变化时 |
| 进行中的运行的开始快照 | `refs/mori/s/<会话 id>/run/<提交>` 保住，写 `run` 记录时换掉 | `kernel/snapshots.ts` | 只改了 gitlink 的段不写记录，开始快照可能没有 ref，被别的会话删除时的 `prune` 删掉 | — |
| 恢复那一段（P→Q、P'→Q'） | 恢复动过的文件不记；其余文件照常记给还在跑的别的会话 | `kernel/timeline.ts` | 整段不记会丢掉同时在跑的会话的改动；整段都记会把恢复当成它们的改动 | 你走查几个会话同时运行时的 Rewind 时 |
| 目录 junction | 当普通目录，照 git 的行为跟进去拍、经它恢复，不另处理 | `kernel/snapshots.ts` | git 自己就这样（复核时实测）；与路径闸按字面判断一致；要排除就得每张快照多遍历一次目录 | git 升级、对目录 junction 的处理变化时 |
| 你在这个会话空闲时手改的文件 | 之后这个会话又跑过一轮、再 Rewind 到更早的轮时被直接覆盖，不进冲突列表；保险快照与 Undo 能找回 | `kernel/rewind.ts` | 照 proposal §5.3 的两种冲突（最近一张快照之后改的、同时运行时改的），不另加一种 | 你走查时觉得这种改动也该进冲突列表时 |
| 整个工作路径被你的 git 忽略 | 快照是空的（排除写成 `/*`） | `kernel/timeline.ts` | 与 git status 一致（proposal §4“排除的文件和 git status 相同”） | 你想在被你的 git 忽略的文件夹里也能 Rewind 时 |
| 一段记录的文件数 | 500，`total` 记全部 | `kernel/snapshots.ts` | 限会话文件的大小；Rewind 用 git 补全 | 会话文件因此明显变大时；你走查时 |
| 树没变 | 不建新提交，沿用上一张 | `kernel/snapshots.ts` | 空闲时的快照不增加对象和 ref | — |
| 段的归属 | 段开始时的“当前轮”；会话自己运行开始的那一段归起始消息 | `kernel/timeline.ts` | proposal 说“当时那一轮”；按段开始算，排队、插话的消息不会把整次运行的改动拿走 | 你走查协作模式、插话时看到改动记错了轮时 |
| 运行记录的写入时机 | 结束快照做完时；运行中崩溃就没有 | `kernel/snapshots.ts` | 这时消息、`mori.wake` 都已写下，能判断起始消息是不是你的 | 运行中崩溃后常丢掉那一轮的改动时 |
| 有序退出 | 等快照队列，受主进程 3 秒上限 | `kernel/index.ts` | 被中止的运行的结束快照多半 1 秒内做完；不延长退出 | 退出时常丢掉最后一张快照时；主进程的 3 秒上限变化时 |
| 运行开始的快照被停止 | 结束它的 git 进程，这次不登记、不拍结束快照，没有 code restore | `kernel/snapshots.ts`、`sessions.ts` | 第一张可能几十秒，停止要立刻生效；pi 在 `agent_start` 就中止，没有工具执行 | 你走查时 |
| `mori-snapshots` 的位置 | `mori-approval` 之后、`mcp` 之前，必需 | `kernel/sessions.ts` | 没有它就没有快照，Rewind 会恢复错；同其他必需扩展 | Mori 的 inline extension 顺序变化时 |
| 整理的命令 | `git prune --expire=now`（不 `gc`） | `kernel/snapshots.ts` | 对象本来就是散的（`gc.auto=0`），prune 快且不重新打包 | 内部仓库因此明显变大时（FS-21） |
| This session 的顺序 | 新的轮在上；轮里按文件第一次出现 | 右栏 | 最近的改动最常看 | 你走查时 |
| 轮的编号 `Turn <n>` | 当前分支上第几条你的消息，不算 `[Mori]` 投递；会话引用的 Turn N 用同一个计数（`turnNumbers`，投递的内容接到前一轮里） | 右栏、Rewind 通知、会话引用 | 轮只挂在你的消息上；两处一个编号，右栏的 Turn 3 与引用芯片的 Turn 3 指同一条消息 | 会话引用的编号规则变化时；你走查协作模式时 |
| 运行开始的快照的阶段行 | `Taking a snapshot… · <秒数>`，只为用户会话自己的运行显示 | `kernel/snapshots.ts`、`StageLine.tsx` | proposal 没给；第一张可到几十秒，发出消息后阶段行不能一片空白；照模型层等待的写法 | 你走查时 |
| Rewind 通知的文字 | `Restored code to before turn <n> · Undo` 等（§5.9、fs-rewind.md），不用 proposal §5.3 图里的 `… before this message` | 对话流 | 通知在对话流末尾，恢复对话后那条消息也不在了，“this message”指不到 | 你走查时 |
| 这条消息恰是叶子时恢复对话 | 导航到它的父条目；父条目是 user 消息、`custom_message` 或没有时失败 | `kernel/rewind.ts` | pi 对“已在目标上”什么都不做（`app/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:3240-3243`） | pi 升级、`navigateTree` 的行为变化时 |
| Rewind 进行中再 Rewind | 拒绝，`This session is already rewinding.` | `kernel/rewind.ts` | 第二次要基于第一次的结果算计划 | 你走查时 |
| 文件行的状态与行数 | 按这一轮第一次与最后一次出现定 A/M/D，建了又删记 D；行数是各段之和 | `renderer` 的归组函数 | 不为显示多跑 git；diff 按这一轮的两端算 | 你走查时 |
| `+N −M` | 当前分支上全部 `changes` 记录之和；只恢复代码不减；窄栏不显示 | `ChatPane.tsx` | 与 This session 一致，不另读 git | 你走查时 |
| 点 git 状态里的文件 | 在阅读器里打开 | 右栏 | proposal 没给；阅读器已有，不新加 diff 命令 | 你走查时觉得要直接看 diff 时 |
| 子文件夹的 git 状态 | 列整个仓库，路径相对仓库根 | `kernel/workspace.ts` | 同在子文件夹里跑 `git status` | 你走查时觉得只要列这个子文件夹时 |
| No code restore 那一行 | 只在这条消息之后有改动时显示 | 菜单 | 没有改动时恢复代码本来就不显示 | 你走查时 |
| Undo 提供到 | 之后出现新的消息条目、或又做了一次 Rewind | 菜单与通知 | proposal 只说能 Undo；之后再撤销会和新的改动纠缠 | 你走查时 |
| Undo 的范围 | 同时把对话回到 Rewind 之前（那次恢复过对话时） | `kernel/rewind.ts` | Undo 是撤销整次 Rewind；只撤代码会留下新代码配旧对话 | 你走查时觉得要能只撤销代码时 |
| 只恢复对话 | 没有 Undo | 菜单与通知 | Undo 靠保险快照（proposal §5.3） | 你走查时觉得只恢复对话也要能 Undo 时 |
| 文字回到输入框 | 放在已有草稿之前，引用芯片恢复 | `state/actions.ts` 的 `putBackQuoted` | 沿用“Put your last message back”的做法 | 你走查时 |
| 冲突列表与记录里的文件列表 | 各最多 200 条，另记总数 | `kernel/rewind.ts`、对话框 | 限长度；Undo 用 git 重新算集合 | 你走查时 |
| 恢复失败 | 整批失败时逐个再试，失败的列出 | `kernel/rewind.ts` | 一个被锁的文件不让其余的都恢复不了 | 逐个再试仍常失败（文件被锁）时 |
| Rewind 进行中发消息 | 拒绝，原文见 §5.10 | `kernel/sessions.ts` | 恢复到一半时开始新的运行，快照会夹在中间 | 你走查时 |
| **§6 路径闸** | | | | |
| 链接与目录联接 | 只对词法上在工作路径里的目标取真实路径：最近一个 `lstat` 看得到的上级取 `fs.realpathSync.native`，接上还不存在的段；工作路径本身也取真实路径；词法上在外面的直接算外面，不碰文件系统 | `kernel/pathGate.ts` `realTarget` | 照 Claude 按写入最终落到的位置判断；不碰外面的路径，网络路径不会让 Windows 送出凭据；外面的链接指回里面只会多问 | Claude 按链接判断的规则变化时；遇到链接让写入多问或漏问时 |
| 真实路径取不到 | `realpath` 失败或 `lstat` 报 `ENOENT`、`ENOTDIR` 以外的错：按工作路径外处理，记日志 | `kernel/pathGate.ts` | 悬空的链接、成环、没有权限时看不出落到哪里，按要问处理（Claude 在这种情况下拒绝操作；Mori 交给你决定） | Claude 的做法变化时；你走查时觉得这类卡太多 |
| “在不在里面”的写法 | 照 pi 的 `getCwdRelativePath`：`relative` 为空，或不等于 `..`、不以 `..` 加分隔符开头且不是绝对路径 | `kernel/pathGate.ts` `insideDir` | 现有写法把 `..notes` 这种名字算在外面；与 pi 判断“在不在 cwd 里”的写法一致 | pi 升级、`getCwdRelativePath` 变化时 |
| 删掉工作路径本身 | 只有命令里 `remove` 为真（删除、移走）的目标是工作路径本身或上级时算受保护；写进工作路径（`cp a.txt .`）算 `inside` | `kernel/pathGate.ts` `classifyTarget` | proposal §4 只说“删掉工作路径本身也算”；不分开的话 `cp`、`mv`、`Copy-Item` 到 `.` 每次都按受保护问 | 你走查时 |
| 一个调用解析的写入目标 | 最多 100 个，之后的记作看不出（`unresolved`） | `kernel/pathGate.ts` | 判断在后台进程里同步做，文件系统调用要有上限；多出来的按写到外面问，只会多问 | 命令语料统计（FS-55）里出现超过 100 个目标的命令时 |
| 分类出错 | 记日志，按 scope `outside`、一个 `unresolved` 目标处理（出卡或没人能批时拒绝） | `kernel/approval.ts` | 异常分支要记日志（AGENTS.md）；不让 pi 把异常变成 `Extension failed, blocking execution` | 日志里常见分类出错时 |
| 停止中 | 只放过 `duty` 与 `read`；写 `.work` 也拒绝 | `kernel/approval.ts` | 同现在只放过 `FREE_TOOLS`；停止后不再执行写入 | 你走查停止时 |
| 段名比较 | 去掉流名（`:` 之后）与末尾的 `.`、空格，不分大小写 | `kernel/pathGate.ts` | Windows 打开文件时同样处理，`.git.`、`.GIT` 也是 `.git` | 遇到开了大小写敏感的目录时 |
| 受保护名单 | §6.5 的表（Claude 2026-10-26 的名单，加 `.mori`、`.pi`、工作路径本身与它的上级） | `kernel/pathGate.ts` `PROTECTED_DIRS`、`PROTECTED_FILES` | proposal §4、§12 第 7 条照 Claude；完整名单由规格定 | Claude 的受保护名单变化时 |
| 名单在工作路径外也用 | 工作路径外的目标按完整路径比名单，命中的按受保护（不能按目录放行） | `kernel/pathGate.ts` | 按目录放行是 Mori 自己的做法；不这样的话放行一次就能不问地改 `~\.gitconfig`、别的仓库的 `.git\hooks` | 你走查时 |
| 按目录放行的范围 | 只含直接放在目录里的目标，不含子目录 | `kernel/approval.ts` | proposal §9 第 2 条“只放行那一个目录”；放行 `..` 的上一级时不会顺带放行旁边的整个目录树 | 你走查时觉得要连子目录一起放行时 |
| 没有按目录放行的情况 | 有 `protected`、`unresolved`、`leaves`、`unanalyzed` 目标，或要放行的目录（目标的上一级；`into` 时目标本身）是盘符根、共享根 | `kernel/approval.ts` | 看不出目标、换了目录或分析不了时不知道放行哪个目录；放行整个盘符根等于不再问 | 你走查时 |
| 命令分析不了（`ok: false`） | 记一个理由 `unanalyzed` 的目标（scope `outside`）：卡上一行 `Couldn’t analyze this command: <reason>`，给模型的 `<why>` 为 `can't be analyzed: <reason>`；收窄（§8.4）当成看不出的写入 | `kernel/pathGate.ts`、`ApprovalCard.tsx`、`kernel/limits.ts` | §7.8 把它按写到外面处理；与 `unresolved` 的原因行分开，说明的是“分析不了”而不是“看不出路径” | 命令语料统计（FS-55）之后 |
| 答错了选项时的命令错误 | `Allow for this session doesn’t apply to writes outside the working directory or to protected paths.`；`This request can’t be allowed by folder.`；`Give either toolName or dir.` | `kernel/approval.ts`、`kernel/sessions.ts` | 界面按请求只给对的按钮，这几条只在界面与后台进程不一致时出现 | — |
| 原因行 `unresolved`、`leaves` 的写法 | `Writes to a path Mori can’t resolve: <text>`、`Runs outside the working directory: <path 或 text>` | `renderer/src/components/ApprovalCard.tsx` | proposal §6 只给了 outside 与 protected 两种；看不出目标、换了目录时显示的是原文而不是路径，要另一种说法 | 你走查时 |
| 命令在 Ask each time 下 | 总是问（scope 为 `inside` 时可按工具名放行），哪怕目标只在 `.work` | `kernel/approval.ts` | 命令能做的不只认出的写入；proposal 的“写 `.work` 不问”指 `edit`、`write` | 命令语料统计（FS-55）之后；你走查时觉得问得太多 |
| 按工具名放行命令的小字 | `You won’t be asked again for commands in this session, unless Mori can’t analyze a command or detects that it writes outside the working directory or to a protected path, or changes to a folder outside it.` | `renderer/src/components/ApprovalCard.tsx` | 列出放行之后仍出卡的全部情况（§7.8 分析不了；§6.4 写到外面、受保护路径、换到外面），按下之后又出卡时与刚读到的承诺一致 | 你走查时；命令语料统计（FS-55）之后 |
| 卡上的目标行 | 最多 5 行，多的写 `and {n} more` | `renderer/src/components/ApprovalCard.tsx` | 一条命令可能有很多目标，卡不能撑满一栏 | 你走查时 |
| 拒绝原文里列的目标 | 每种最多 5 个，多的写 `and <n> more` | `kernel/approval.ts` | 同上，控制工具结果的长度 | 你走查时 |
| 没人能批时的拒绝原文 | §6.15 | `kernel/approval.ts`（开头 `Denied by Mori: ` 在 `shared/workspace.ts` 的 `DENIAL_PREFIXES`） | proposal 没给原文 | 内网模型对英文说明理解不好时 |
| Full access 的悬停说明 | `Edits, writes, and commands inside the working directory run without asking.` | `renderer/src/components/PermissionMenu.tsx` `modeNote` | 照现在用当前模式的说明，取确认框第一句的现在时 | 你走查时 |
| Ask each time 的身份句 | 与现在逐字相同 | `kernel/memoryText.ts` | 仍然准确（“may wait”）；身份段仍因 §7 的 `.work` 一句而变，fixture 照样重录 | 真实模型走查（FS-114）之后；内网模型对英文说明理解不好时 |
| Full access、没人能批的身份句 | §14 的两句 | `kernel/memoryText.ts` | proposal §10 只说“按模式改写”，没给原文 | 真实模型走查（FS-114）之后；内网模型对英文说明理解不好时 |
| 有新字段的 fixture | 载荷变了的重录，不给它们补默认值；回放桥只为会话信息里界面新加的字段补 synthetic 的空值（同 `teamInfo`） | `tests/fixtures/m2/*` 与 m3–m6 里带批准请求的、`tests/fixtures/tb/tb-approval.json` 等；`tests/ui/harness/replay.js` | 批准请求的事件改了（AGENTS.md 第 2 条：会话的事件有变化时重录）；只缺界面字段的录制（m1、v1、md）模型看到的没变 | 批准请求的事件再改时 |
| **§7 命令分析与 .work** | | | | |
| 解析失败怎么算 | 按写到外面（出卡；没人能批的会话直接拒绝） | `approval.ts`（§6 用 `ok: false`） | Claude 的 worktree 隔离对看不出 git 用法的命令形状同样拦下（§7.7 的 Claude 文档）；放行会漏掉复合结构里认得出的写法。Ask each time 下命令本来就问；Full access 下只多一张卡。按语料统计（FS-55）再定 | 命令语料统计（FS-55）之后 |
| 认得出的写法名单 | §7.5 的名单：proposal §5.1 列的，加上 Claude 认的 `touch`、`rmdir` 与重定向的各种写法，加上同类的 `ln`、`Add-Content`、`New-Item`、`Rename-Item`、`Tee-Object` | `commandScan.ts` | proposal §11 把“命令分析覆盖的写法”留给规格；名单外的照常跑。按语料统计（FS-55，proposal §14）再定 | 命令语料统计（FS-55）之后 |
| 命令文字的上限 | 1,000,000 个字符，超过为解析失败 | `commandScan.ts` `SCAN_MAX_CHARS` | 资源有上限；分析时间与长度成正比，目标是 1 MB 一次不超过 200 ms（FS-49 量） | 1 MB 的命令一次分析超过 200 ms（FS-49）时 |
| 嵌套的上限 | 32 层（括号、替换、嵌套 shell、eval 合计），超过为解析失败 | `commandScan.ts` `SCAN_MAX_DEPTH` | 防止递归过深；嵌套这么深的真实命令少见 | 命令语料统计（FS-55）里出现超过 32 层的命令时 |
| 命令名或命令文字来自变量、替换或输入 | 解析失败 | `commandScan.ts` | 运行前看不出要跑什么，同“分析不了” | 命令语料统计（FS-55）之后 |
| `-EncodedCommand`、`env -C` / `-S`、PowerShell 的 `-WorkingDirectory` 与不认识的选项 | 解析失败 | `commandScan.ts` | 解码或换目录会让解析不准；这些写法少见，宁可问 | 命令语料统计（FS-55）里这些写法常见时 |
| HOME | 不当已知变量：`~` 与 `$HOME`、`$env:USERPROFILE` 都看不出来 | `commandScan.ts` | proposal §5.1 把 `~` 列为看不出来（照 Claude）；`$HOME` 同值，同样处理 | 命令语料统计（FS-55）里 `~` 常见、问得太多时 |
| `$PWD` | 当作当前目录 | `commandScan.ts` | 分析时本来就知道当前目录 | — |
| msys 根下的路径（`/tmp`、`/usr`…） | 看不出来（`shell-path`） | `commandScan.ts` | 本机实测 `/tmp` 是用户临时目录，不跟 TMP 走；其余落在 Git 的安装目录 | Git for Windows 升级、`/tmp` 的映射变化时 |
| 不是目标的设备路径 | `/dev/null` `/dev/stdout` `/dev/stderr` `/dev/stdin` `/dev/tty` `/dev/fd/<n>`、PowerShell 的 `$null` | `commandScan.ts` | 照 Claude（`/dev/null` 与 fd 形式跳过，https://code.claude.com/docs/en/permissions#redirections） | Claude 跳过的设备路径变化时 |
| 换目录的报告 | `scanCommand` 对每一次换目录之后运行的非只读命令都给 leave（字面的 `dir`），不判断在不在工作路径里；§6.4 按真实路径丢掉仍在里面的 | `commandScan.ts`、`pathGate.ts` | 按字面判断会漏掉指向外面的目录联接（`cd <联接> && npm i`）；`scanCommand` 不收回调，保持纯函数 | 命令语料统计（FS-55）里换目录的命令问得太多时 |
| bash 的 cd 在多节管道里、`&` 后台里 | 不改当前目录 | `commandScan.ts` | bash 的子 shell 语义（本机实测） | Git Bash 升级时 |
| PowerShell 的 Set-Location | 一直延续，括号与脚本块不隔开 | `commandScan.ts` | PowerShell 的位置属于运行空间（本机实测） | PowerShell 升级时 |
| 看不出来的当前目录 | `cd`（无参数）、`cd -`、多个操作数、`pushd`（无参数或 `±N`）、`popd` 栈空、PowerShell 的 `Set-Location`（无参数）、`cd -`、`cd +` | `commandScan.ts` | 运行前不知道去哪 | 命令语料统计（FS-55）之后 |
| 只有赋值的 `GIT_DIR=` / `GIT_WORK_TREE=` | 当作 export | `commandScan.ts` | 偏严，写法少见 | 命令语料统计（FS-55）里这种写法常见时 |
| 只读名单 | §7.7 的三张名单 | `commandScan.ts` `READ_ONLY_COMMANDS` | proposal 只举了 `ls`、`cat`、`git status`、`git log`；名单取不写文件、不跑别的程序的常用命令，按语料统计再调 | 命令语料统计（FS-55）之后 |
| PowerShell 的参数表 | 5.1 与 7 的并集（本机 `Get-Command` 读出）；参数名不认识、有歧义、多出位置参数、splatting → 一个看不出来的目标 | `commandScan.ts` | PowerShell 多半会报错不执行，但动态参数可能没列全，宁可问 | PowerShell 升级、cmdlet 的参数变化时 |
| PowerShell 的通配符 | `LiteralPath` 以外的参数里的 `*` `?` `[`（引号里也算）→ 看不出来 | `commandScan.ts` | `-Path` 按通配符展开，可能写到几个文件 | 命令语料统计（FS-55）里因此问得太多时 |
| PowerShell 的提供程序路径 | 两个字母以上的驱动器（含 `Temp:`）、`名字::` → 看不出来；`FileSystem::` 去掉前缀 | `commandScan.ts` | 不是工作路径里的文件，偏严 | 命令语料统计（FS-55）之后 |
| 以 `\` 开头的路径（两种 shell） | 当前目录所在盘的根下 | `commandScan.ts` | PowerShell 与 Git Bash 都这样解析（本机实测） | PowerShell 或 Git Bash 升级时 |
| 盘符相对路径（`C:x`，含 bash 里不加引号的 `C:\x`） | 看不出来（`drive-relative`） | `commandScan.ts` | 每个盘的当前目录在运行前不知道；不加引号的 `C:\x` 在 bash 里其实是 `C:x`，多半是写错了，问一次 | 命令语料统计（FS-55）之后 |
| 命令名的大小写 | 一律不分大小写（保留字除外） | `commandScan.ts` | Git Bash 找外部程序不分大小写（本机实测 `RM` 跑的是 `rm`）；内建命令按不分算只会多问 | Git Bash 升级时 |
| 落进目录（`into`） | 只按文字认：`-t` 的值、两个以上的源时的目标、以分隔符结尾或最后一段是 `.` / `..` 的目标、Copy-Item / Move-Item 省略的 Destination | `commandScan.ts` | 纯函数不读文件系统；§6 的按目录放行据此不放宽到上一级（proposal §13 第 1 条）。看不出是不是目录时按文件，放行宽一级 | 你走查按目录放行时 |
| 结构缺结束词 | `fi`、`done`、`esac`、bash 的 `}` 缺了到末尾自动结束；引号与括号（含 PowerShell 的 `{`）缺了才失败 | `commandScan.ts` | 少报解析失败：bash 遇到没结束的结构报语法错、这一段不跑，按写入算只会多问；前面完整的命令照样会跑，必须分析 | 命令语料统计（FS-55）之后 |
| here-doc 没有结束行 | 正文到文字末尾 | `commandScan.ts` | 同 bash（只警告，本机实测） | Git Bash 升级时 |
| xargs 与 `find -exec` 的输入 | 没有替换串时在末尾补一个看不出来的操作数；`{}` 与替换串看不出来 | `commandScan.ts` | xargs 把输入的项接在参数后面 | 命令语料统计（FS-55）之后 |
| 写入去重 | form、text、path、remove 都相同的只留第一个 | `commandScan.ts` | 卡上不重复 | — |
| 什么时候建 `.work` | 放行 bash / powershell 调用，或放行写进 `.work` 的 write / edit 之前；每次都检查，不缓存。另外 §11 建 worktree、Initialize git 时建（proposal §5.4） | `approval.ts`、§11 → `workspace.ts` `ensureWork` | 用到时才建，没用过命令的文件夹里不出现；不监视（负责人偏好）；检查很便宜，删掉后能自己恢复 | 你走查时 |
| `.work` 建不起来（是文件、只读文件夹、没有权限） | 挡下这次调用并说明原因，记错误日志 | `approval.ts` | proposal 没说；照 AGENTS 第 6 条遇到阻塞就停下来报告，不静默换路线；另一种做法（照常跑、TEMP 不改，在工具结果里说明）是换路线的 fallback，不采用。这样这个文件夹里的命令都跑不了，直到你改名或删掉那个 `.work` | 遇到真实的 `.work` 建不起来、你想让命令照常跑时 |
| `.work/.gitignore` | 内容 `*\n`；只在没有时写（`wx`），从不覆盖 | `workspace.ts` | proposal §4；你改过的保留 | — |
| 工作路径不在时 | `ensureWork` 什么都不建 | `workspace.ts` | 不把删掉的 worktree 重新建出来 | — |
| 设哪些变量 | TEMP、TMP、TMPDIR，都指到 `<工作路径>\.work\tmp`；先删掉各种大小写写法；另去掉 CDPATH 的各种大小写写法（不设新值） | `workspace.ts` `workEnv` | proposal 写 TEMP / TMP；TMPDIR 是 Git Bash 的 `mktemp` 与 Python 先看的（本机实测）；继承的 CDPATH 会让 bash 的 `cd 相对名` 换到别处，§7.7 的解析就不准 | 遇到别的程序不看 TEMP、TMP、TMPDIR，临时文件仍写到外面时 |
| 命令自己改了 TEMP、TMP、TMPDIR、PWD | 这条命令里（含之后嵌套的 shell、eval 文字）这个名字看不出来（`variable`）：开头的赋值、`env -i` / `-u`、export、只有赋值、PowerShell 的 `$env:` 都算 | `commandScan.ts` | `vars` 是 `spawnHook` 设的值，命令改掉之后不再对（Git Bash、pwsh 实测写到了工作路径外）；偏严，严格说只有嵌套文字看到开头赋值的新值 | 命令语料统计（FS-55）之后 |
| 命令里设了 CDPATH | 之后 bash 的 `cd` / `pushd` 操作数不以 `/`、`\`、`.`、`~`、盘符开头时目录看不出来；`unset CDPATH` 不恢复 | `commandScan.ts` | bash 对这种操作数先查 CDPATH（Git Bash 实测换到了工作路径外）；偏严，写法少见 | 命令语料统计（FS-55）之后 |
| PowerShell 外部程序参数里的 cmd.exe 元字符 | 去掉 PowerShell 引号后不含空白、却含 `>` `<` `\|` `&` 的参数，与 `--%`，解析失败 | `commandScan.ts` | `.cmd` / `.bat` 垫片（npm、npx、tsc 等）由 cmd.exe 再解析一遍（pwsh 实测 `npm.cmd --version '>' ..\x` 写出文件）；看不出命令名是不是垫片，按文字从严，§7.13 统计后再定 | 命令语料统计（FS-55）之后；你走查时觉得问得太多 |
| 换掉的工具 | `bash`、`powershell` 用 `customTools` 换，`defaultActive: false`，工具页来源仍为 Built-in | `workspace.ts` `shellTools`、`resources.ts` `toolSource` | 启用与显示与内置工具相同（§7.11 的核实） | pi 升级、内置的 bash、powershell 工具或 `customTools` 变化时 |
| `.work` 的清理 | 不清理，不设上限 | — | proposal §9 第 5 条没有后台清理；草稿在里面；工作路径在 OneDrive 里时，命令的临时文件也会被同步 | `.work` 明显变大、或 OneDrive 的同步负担明显时 |
| 解析失败的日志 | `[kernel] command not analyzed (<shell>): <reason>`，不写命令原文 | `approval.ts` | 语料统计与排查用 | — |
| **§8 收窄** | | | | |
| `limits` 里 `true` | 与不写相同，不存 | `kernel/limits.ts` `parseLimits` | proposal 的形状只有 `false`；模型写 `true` 时不报错，少一次重试 | — |
| `limits` 里的键名与未知键 | 键名照顶层归一；未知键丢掉 | `kernel/boardTools.ts` `prepareToolArgs` | 与平行 Agent 规格 §6.2 顶层参数的规则一致，不另立一套 | 平行 Agent 规格 §6.2 的归一规则变化时 |
| `write_paths` 的项数 | 1–10（JSON schema 的 `minItems`、`maxItems`） | `kernel/boardTools.ts` 的 schema | “缩到几个子目录”；空列表没有意义（要什么都不写用 `write: false`）；10 项写进工作卡也不长 | 真实模型常写超过 10 项时 |
| `write_paths` 的写法 | 只认相对路径；出界、整个工作路径报错；归一为 `/` 分隔、末尾 `/`、去重、去掉被包含的；不检查是否存在；一项可以是文件 | `kernel/limits.ts` | proposal 只说“工作路径下的几个子目录”；归一后工作卡、拒绝原文和比较都简单 | 你走查时 |
| `write: false` 与别的项同时写 | 去掉 `commands`、`write_paths` | `kernel/limits.ts` | 已经包含在 `write: false` 里 | — |
| `mcp: false` 的范围 | MCP 工具和扩展注册的、不是职责工具的工具 | `kernel/limits.ts` `checkLimits` | proposal §5.1 把“MCP 和扩展注册的工具”当成一类（看不出写什么）；只关 MCP 时扩展工具就成了对话 Agent “只转达”的缺口 | 遇到扩展工具要和 MCP 分开收窄时 |
| `agent_message.limits` 的去向 | 只在开临时提问时用；发到 task、进座位会话时不用（不合格仍拒绝） | `kernel/teamTools.ts` `agentMessage` | proposal 只说“这个临时提问的实例按它判断”；座位会话本来就被程序收窄 | 你走查协作模式时 |
| 合并会话在协作模式下的收窄 | `{ write: false, mcp: false }`，拒绝原文用 `RELAY_ONLY` | `kernel/team.ts` `narrowingFor` | 两个席位的收窄取并集；与现在（读取类、没有 MCP）效果相同 | 你走查协作模式时 |
| 收窄拒绝原文的开头 | task `Not allowed for this task`；临时提问 `Not allowed for this question`；立项 `Not allowed while deciding requests`；结案 `Not allowed while closing a request`；订阅 `Not allowed in a subscription`；对话会话整句 `RELAY_ONLY` | `shared/workspace.ts` `NARROWING_LEADS` | proposal 只给了 task 的例子；写明是谁的限制，“限制是派它的 Agent 或程序定的，不是你定的”；放在 shared 是因为界面要认出它们（`DENIAL_PREFIXES`） | 真实模型走查（FS-67）之后；内网模型对英文说明理解不好时 |
| 收窄拒绝的规则文字 | §8.4 表 | `kernel/limits.ts` | proposal 的例子 “writes are limited to src/” 加上 `.work/` 与越界的目标，模型知道哪里能写 | 真实模型走查（FS-67）之后 |
| `write_paths` 怎样比 | 目标按 §6.3 取真实路径、相对工作路径的真实路径，按段比（不分大小写，去掉末尾的 `.` 与空格）；归为 `work` 的总在里面 | `kernel/limits.ts` `checkLimits` | 与 §6 的 `.work`、受保护名单用同一套路径与段名规则，链接与大小写不会让写入绕出列表 | — |
| 有 `write_paths` 时换到工作路径外执行的命令 | 与看不出的目标一样拒绝（`Mori can't tell where this writes`） | `kernel/limits.ts` `checkLimits` | proposal §5.1 把它们按写到外面处理；换目录之后写到哪里看不出 | 命令语料统计（FS-55）之后 |
| 实例的工具白名单 | pi 设置的默认工具 + `mcp__*` + 职责工具，所有种类相同 | `kernel/roles.ts` `instanceTools` | “碰文件的工具对所有 Agent 都一样”；就是现在基座 task 实例的那一组，不新加扩展工具 | pi 升级、默认工具变化时 |
| 工作卡与 `board_read` 的限制写法 | `· Limits: <limitsText>`；没有限制时不写 | `kernel/boardText.ts` | 代替 `· read-only` / `· changes files` | 你走查时 |
| 立项段对 `limits` 的建议 | 除非要跑命令或改文件，写 `{"write": false}` | `kernel/boardText.ts` `MARK_LINE` | 保住现在“默认只读”的并行与写入锁行为 | 真实模型走查（FS-67）之后；你走查时觉得写 task 排队太久 |
| **§9 你不在** | | | | |
| 后台进程的焦点初值 | `focused = true` | `kernel/away.ts` | 主进程第一次告诉它之前没有窗口，也没有卡 | — |
| 接上通道时补发一次焦点 | `connectWindow` 发 `port` 之后按当前状态发 `window_focus`，不论值变没变 | `main/index.ts` | 重启的后台进程不知道窗口状态；proposal 只写了“焦点变化时发” | — |
| “在前台”的判断 | `isFocused() && !isMinimized()`，听 `focus`、`blur`、`minimize`、`restore` | `main/index.ts` | Windows 上最小化一般先失焦，加上 `isMinimized` 防止漏判 | Electron 升级、窗口焦点事件的行为变化时 |
| 同时挂着的几张卡 | 各自计时，同一时刻到时 | `kernel/away.ts` | 只显示一张，但“你不在”对全部卡都成立 | 你走查时 |
| 设置的存放 | `<userData>/away.json` `{ "timeout": "5m" }` | `kernel/away.ts` | 后台进程要用；Mori 没有全应用的设置文件，只为这一项建一个最小的 | Mori 有了全应用的设置文件时 |
| 设置的位置 | 设置页新增一节 `General`，排在 UI issues 之后 | `SettingsPage.tsx` | 现有三节都不合适；Clean up worktrees 另在 `Storage` 一节（§11.10），两节都留 | 设置页再加节时；你走查设置页时 |
| 改设置何时生效 | 下一次开始计时起 | `kernel/away.ts` | 改设置时窗口在前台，没有正在走的计时 | — |
| 测试用的时长 | 环境变量 `MORI_AWAY_TIMEOUT_MS` 替换三档时长 | `kernel/away.ts` | 60 秒起的时长让 App 测试太慢；照 `MORI_USER_DATA` 的写法 | — |
| 倒计时的文字 | `You’re away · Denying in Ns` / `You’re away · Using the recommended options in Ns` / `You’re away · Cancelling in Ns` | 三种卡 | Claude 只说最后 20 秒显示倒计时，原文未知；照 ui-strings 的 “ · ” 写法 | 拿到 Claude 的原文时 |
| 拒绝的工具卡理由 | `No answer while you were away` | `model.ts` `parseRejection` | 同 `You pressed Stop` 的写法 | 你走查时 |
| 拒绝原文里的时长 | `60 seconds`、`5 minutes`、`10 minutes` | `kernel/away.ts` | proposal §5.2 的原文写 “within 5 minutes” | 三档时长变化时 |
| 实例的拒绝原文 | task 实例、结案会话写 “Mention it in your handoff.”，其余实例同用户会话 | `kernel/away.ts` | 只有这两种有交接单 | 真实模型走查（FS-82）之后 |
| 提醒不含扩展询问 | 扩展的取消只进界面列表，不进提醒 | `kernel/away.ts` | 模型没发起、也没见过这张卡 | 你走查时 |
| 提醒只在正常结束时补 | `outcome === 'completed'` | `kernel/away.ts` | 出错结束时再请求一次多半还会出错 | 真实模型走查（FS-82）之后 |
| 已交接的 task 实例不补提醒 | `GateOutput.handedOff?.()` 为真（这次运行有成功的 `task_handoff`）时不补 | `kernel/away.ts`、`kernel/instances.ts` | 交接之后的调用一律被拒绝（平行 Agent 规格 §7.1），再跑一次没有用 | 平行 Agent 规格 §7.1 交接之后的规则变化时 |
| 提醒清单何时清空 | 这个 pi 会话的 `agent_settled` | `kernel/sessions.ts` | 一次运行里 `agent_start` 会来好几次（§9.8），只有 `agent_settled` 每次运行一次 | pi 升级、`agent_settled` 或 `agent_start` 的次数变化时 |
| 焦点消息的日志 | 每收到一次记 `[kernel] window focus: <true\|false>` | `kernel/index.ts` | 让 App 测试核对“值不变时不发”；不加别的测试入口 | — |
| 提醒条目的 customType | `mori.away_reminder` | `kernel/away.ts` | 与记录 `mori.away_decision` 分开 | — |
| 记录里参数的截短 | 字符串截到 300 字符，去掉 `content`、`edits` | `kernel/away.ts` | 界面只用它算工具卡标题；不把整份写入内容再存一遍 | 你走查时 |
| 扩展询问不闪任务栏 | 只有批准卡与提问卡闪 | `actions.ts` | 现在扩展询问不闪（`app/src/renderer/src/state/actions.ts:362`）；proposal 没要求改 | 你走查时觉得扩展询问也该闪时 |
| “Decided while you were away” 不进导出与会话引用 | 只在对话流里显示 | 界面 | proposal 只要求在这一轮末尾列出 | 你走查导出与会话引用时 |
| **§10 ask_user_question** | | | | |
| 扩展名与位置 | `mori-question`，mori-memory 之后、mori-approval 之前 | `sessions.ts` | 只在用户会话里；没有 `tool_call` 处理器，放哪里都不影响判断顺序 | Mori 的 inline extension 顺序变化时 |
| 不是必需的扩展 | 加载失败时会话照常打开 | `sessions.ts` | 不影响安全；少了它只是不能用卡提问 | — |
| 文字长度 | `question` 1–500，`label` 1–60，`description` ≤ 300，Other ≤ 2000 字符 | `askQuestion.ts` | Claude 只限 `header` ≤ 12；其余没有公开的上限 | 拿到 Claude 的上限时；真实模型常超长时 |
| `Other` 不能作 label | 不分大小写 | `askQuestion.ts` | 卡上总有 Other（照 Claude），同名会分不清 | — |
| 多选的推荐项 | 仍是一个 label，你不在时只选它 | `askQuestion.ts` | proposal 的 `recommended` 是一个推荐项 | 你走查多选的提问时 |
| 卡的布局 | 问题按顺序列在一张卡上，最后一个 Submit；不预先选中推荐项 | `AskCard.tsx` | Claude Code 是一题一页再 Submit；一张卡更简单。不预选，免得一下 Enter 就替你选了 | 你走查时 |
| 卡的排序 | 批准卡在前；提问卡与扩展询问卡按到达顺序，一次一张 | `ChatPane.tsx` | 沿用“批准卡先显示”（extension-ui.md） | 你走查时 |
| Esc | 拒绝回答，工具卡 `Denied · You declined to answer` | `AskCard.tsx`、`model.ts` | 同批准卡 Esc 拒绝、扩展询问卡 Esc 取消 | 你走查时 |
| 拒绝回答的原文 | 见 §14 | `askQuestion.ts` | 照 Claude 拒绝工具时“停下来等用户”的意思 | 真实模型走查（FS-93）之后；内网模型对英文说明理解不好时 |
| 请求 id | `ask-<n>` | `askQuestion.ts` | 与 `approval-<n>`、扩展询问的 `question-<n>` 分开 | — |
| 多选答案的连接 | `, ` | `askQuestion.ts` | 照 Claude Code 的已知写法 | 拿到 Claude Code 的原文时 |
| 工具卡 | 标题 `Ask · <各问题的 header，用 , 连接>`（例如 `Ask · Database, Scope`）；等待时 `Waiting for your answer` | `toolTitle.ts`、`ToolCard.tsx` | 现有标题是“动词 对象”（`Run npm test`），`agent_message` 已经有 `Ask <role>`（`app/src/shared/team.ts:578`）；用 “ · ” 隔开，免得 header 读成角色名。状态词沿用阶段行的 `Waiting for your answer` | 你走查时 |
| 拒绝回答、停止的结果是错误 | `isError: true`，原文 `ASK_DECLINED_TEXT`、`ASK_STOPPED_TEXT`（`shared/workspace.ts`） | `askQuestion.ts` | 照 Claude Code 拒绝工具调用时的错误结果；界面重新打开时只对错误结果认拒绝（`app/src/renderer/src/state/history.ts:68`） | — |
| 停止的工具卡 | `Stopped`（不是批准卡停止时的 `Denied · You pressed Stop`） | `transcript.ts`、`history.ts` | 提问不是被拒绝的操作；同其他工具停止时的写法 | 你走查时 |
| 不做参数键名归一 | 没有 `prepareArguments` | `askQuestion.ts` | `prepareToolArgs` 只管顶层的键；写错的键由 pi 的校验报错 | 真实模型常写错键名时 |
| 提问卡让任务栏闪烁 | 同批准卡 | `actions.ts` | 提问卡同样挡住 Agent | 你走查时 |
| 交接选项的长度 | 2–4 项，每项 1–60 字符 | `board.ts` | 与提问卡的选项一致 | 提问卡选项的长度变化时 |
| 强制填写 C 级不带选项 | `tagFormat` 不变 | `handoffForm.ts` | 不改现有的强制填写文字；A、B 级自动带上 | 内网 C 级模型的交接常缺选项时 |
| **§11 worktree 与 Initialize git** | | | | |
| worktree 名字 | 第一条消息里你写的字（跳过引用块）→ NFKD 去附加符号、小写、`a-z0-9` 词、最多 5 个词且不超过 30 个字符；没有词时 `session`；后接 `-` 和 6 个十六进制字符 | `kernel/workspace.ts` `worktreeName` | Claude 用 `<名字>-<6hex>`；proposal 没给取名规则；只用 ASCII 保证分支名合法、路径短 | 你走查时觉得名字难认时 |
| 撞名重试 | 换后缀最多 3 次，之后失败 `<路径> already exists.` | `createWorktree` | 6 位十六进制撞上的机会极小，不值得更多处理 | — |
| 在 Mori worktree 里再开 worktree | 放在同一个 R 下，不嵌套（切出点按 §0 写规格时定的第 6 条） | `createWorktree` | 照 Claude：fork 出的 worktree 与原来的并列；避免路径越套越长 | Claude 的做法变化时 |
| 第一条消息的文件引用 | 交给 pi 之前，原来 cwd 里的文件引用的 `path` 换到新 cwd 下同样的相对路径（`refsInto`）；`text` 不改 | `startInWorktree`、`actions.ts` | 不换的话界面认不出引用块、整段露出来；发给模型的文字不变 | — |
| 开关在窄栏 | ≤ 460px 只显示图标 `branch`，名字在读屏名与悬停里；不截短 | `WorktreeToggle.tsx`、`icons.tsx` | 同一档权限、范围、Effort 去掉 ▾；这一项是开关，截短后读不出 | 你走查窄栏时 |
| exclude 行 | `.mori/worktrees/`（不带开头的 `/`），没有这一行才加 | `createWorktree` | 照 Claude 的 `.claude/worktrees/` | Claude 的写法变化时 |
| `worktree add` / `worktree remove` / Initialize git 的 `add -A`、`commit` 的超时 | 各 120 s | `kernel/workspace.ts` 调 `git.ts` 时 | 检出大仓库比读状态慢得多（本机 788 个文件 1.27 s）；§3 的默认超时是给状态用的 | 量过公司仓库检出与提交的耗时时 |
| 建 worktree 期间 | 后台进程拒绝这个会话的其他命令（`The worktree is still being created.`），不能停止；界面不能发送、Stop 与输入框下一行不可用，阶段行 `Creating worktree…` | `sessions.ts` `creatingWorktree`；`Composer.tsx`、`StageLine.tsx` | git 检出中途杀掉会留下一半的 worktree；通常只要一两秒 | 大仓库上建 worktree 常要很久时 |
| 重建时沿用的设置 | 批准状态（同一个对象）、选择范围、思考强度、会话名、协作模式（按这个顺序设回） | `startInWorktree` | 这些是你在第一条消息前选的；Check again 的重建不沿用，这里不沿用就会在你眼前变回默认 | 第一条消息前能选的设置增加时 |
| 建 worktree 失败的清理 | `worktree remove --force --force`、`worktree prune`、还在就删文件夹、`branch -D`；每步失败只记日志；配置和 exclude 行留着 | `createWorktree` | 实测失败的 `worktree add -b` 也会留下分支；超时被结束的 add 留下锁，一个 `--force` 删不掉（§11.1） | git 升级、失败的 `worktree add` 留下的东西变化时 |
| 没装 git 时删除 worktree 会话 | 照常删会话，worktree 不动，确认框写明 | `deleteSession` | 会话总能删；不用 git 删 worktree 会留下登记 | 你走查时 |
| 归档时删 worktree 的结果 | 不显示，只记日志 | `projects.ts` `archiveSession` | 归档不确认（方案 5.3）；留下的在设置页能看到 | 你走查时觉得归档也要说明时 |
| 删除时 worktree 正被别的开着的会话用 | 不删 worktree，照常删会话，确认框写明 | `deleteSession`、`worktrees.cleanUp` | 删了会让那个会话的工具全部失败 | 你走查时 |
| “干净”的判断 | `git --no-optional-locks status --porcelain` 为空；被忽略的文件（`.work/`、`node_modules`）不算，删 worktree 时一起删 | `worktrees.list`、`cleanUp` | 与 `git worktree remove` 自己的判断相同（实测） | git 升级、`git worktree remove` 的判断变化时 |
| 恢复 worktree | 登记里还有它（含 `locked` 的）时先 `worktree remove --force --force` 再 `prune`，然后 `worktree add <path> <branch>`（120 s；失败时清掉建了一半的，不删分支）；文件夹在而登记没有时打开失败、不替你删；按 `worktreeOf(cwd)`，不要求 `mori.worktree` | `openFromFile` | 实测手工删掉的 worktree 不清登记就 add 不上，`prune` 不删锁着的登记；同一 worktree 里另开的会话也能打开 | git 升级时 |
| 删 worktree 后文件夹还在 | `fs.rm` 递归删掉（Node 不跟进联接）；仍在则 `removed: false` 与原文 | `worktrees.cleanUp` | 实测里面有目录联接时 `git worktree remove --force` 只删登记；留下的文件夹让这个会话再也恢复不了 | git 升级时 |
| 共用配置里有 `core.worktree` | 不建 worktree，说明原因，什么都不改 | `createWorktree` | 实测这时链接出去的 worktree 以主文件夹为工作树，Agent 在里面提交的是主文件夹；挪配置是你的仓库的事 | 遇到这样的仓库、你想让 Mori 替你挪配置时 |
| Initialize git 中途失败 | 结束 git 后删掉本次 `git init` 建的 `.git`，文件夹回到之前；本来就有 `.git` 时不删 | `initGit` | 被结束的 `git add` 在你的新仓库里留下 `index.lock`，仓库留着你就得自己清锁；那个 `.git` 里只有 git 写的文件 | 你走查时 |
| 界面的本次信任回答 | 按 `projectFolder(cwd)` 记（记住到 `trust.json` 的照 pi，不改） | `renderer/src/state/trust.ts` | proposal §13 第 11 条没列信任；在主文件夹回答过，同一次运行里不再为它的 worktree 问 | pi 的信任规则变化时 |
| 侧栏分支标签 | 建 worktree 时的分支名（从路径推出），不读 git；空间不够时先截断分支标签 | `SessionTree.tsx` | 不为侧栏调 git；右栏有实时的分支 | 你在 worktree 里常切分支、标签对不上时 |
| 设置页的位置 | 新的一节 `Storage`，排在 `General` 之后，块名 `Worktrees` | `SettingsPage.tsx`、`settings/StorageSection.tsx` | 照 Claude 的 Settings > Storage；When you’re away 在 `General`（§9.6），两节都留 | 设置页再加节时；你走查设置页时 |
| Initialize git 的确认框焦点 | 在 `Cancel` | `InitGitDialog.tsx` | 会在你的文件夹里建仓库并提交，同删除确认框的做法 | 你走查时 |
| Initialize git 在运行中 | 拒绝（`This session is still running. Stop it first.`） | `initGit` | 不在 Agent 写到一半时提交 | — |
| 没设 user.name / user.email | Initialize git 什么都不做，说明要设什么 | `initGit` | 不替你用别的名字提交；做之前检查，不留下半个仓库 | 你走查时 |
| 第一次提交 | `git commit --allow-empty -m "Initial commit"` | `initGit` | 空文件夹也要有提交，Worktree 开关才会出现 | 你走查时 |

## 收尾检查（2026-10-27 无人模式下定、待负责人审）

来源：[收尾检查 Proposal](../proposals/finish-check.md) §13（已按一轮 Fable 评审改过）。机制、上限和范围是负责人 2026-10-27 定的（proposal §12），不在这里；
下面每一行都是负责人不在时（无人模式）按推荐定下的，**待负责人审**。构建规格还没写，“位置”先写 proposal 的节，规格写好后改成代码落点。

| 默认值 | 取值 | 位置 | 理由 | 何时复查 |
| --- | --- | --- | --- | --- |
| 正式名字 | 收尾检查（代码名 finish check）；工具 `finish`；会话条目 `mori.finish_check` | proposal §4 | “检查点”在 Claude 里指 Rewind 的 checkpoint，文件系统 Proposal 也这样用，换个词免得混；`finish` 短，没有参数，也不像要填内容；不用 pi 的事件名 | 你审时 |
| 文档放哪 | 单独成文 `docs/proposals/finish-check.md`；prompt-and-memory 的开头、§5.2、§13 挂链接 | — | 现有 proposal 一个机制一份；它还要解决骤停，不只是记忆；prompt-and-memory 的 §15、§16 是那一版的决定，接在后面会混 | 你审时 |
| `finish` 的工具卡 | 不显示：实时、打开会话、会话引用的 `[Tool]` 行、阶段行的工具名；只有 `finish` 的助手消息不留空位 | proposal §11 | Claude 没有这种工具，算 Mori 自己的决定；最像的 Stop hook 通过时看不到；显示的话每一轮末尾都多一张没有内容的卡 | 你走查时 |
| 过程的折叠 | 照 Claude 桌面版（Code 标签页）：一轮里最后一次干活（`finish` 以外的工具调用）之前的文字和工具卡收进可以展开的过程，之后的文字完整显示；作为 proposal §14 第 2 步单独做；折叠头的文字、悬停和读屏名在第 2 步的规格里对照 Claude 桌面版定、进 ui-strings；Code 标签页若其实不折叠，改记为 Mori 自己的决定 | proposal §11、§14 | Claude 有对应时完全照它；检查之后接着干活时一轮里会有两段像回复的文字；它影响所有多工具的轮次，单独一步、单独走查，收尾检查不依赖它 | 你走查时；不想改现有的平铺显示时 |
| 检查时的阶段行 | 照常按事件走（回复写完到检查请求发出之间不显示 → “Waiting for the model… Ns” → “Thinking…” → 写 `finish` 调用时短暂 “Responding…”），不加新文字 | proposal §5.1、§11 | 方案原则 4“界面不谈自己”；界面已要认出 `finish` 来藏卡和阶段行的工具名，不为“Responding…”再加一处 | 你走查时觉得收尾等得莫名其妙时 |
| 检查之后模型写的话 | 照常显示，不藏；它就是最终回复（TaskBoard 的 `run.lastText` 也是它），单独写或和 `finish` 写在同一条消息里都一样 | proposal §4、§8 | 状态有来源，Mori 不藏模型写出的字；检查那一行要求只调 `finish` | 真实模型走查里这种话常见时 |
| 检查那次请求出错 | 错误卡照常显示原文，但不带“Put your last message back in the message box”；侧栏显示 Error；回复留着 | proposal §8、§11 | 错误都显示原文（方案 5.8）；你的消息已经答完，放回输入框只会让你重发；界面从对话流认得出（错误紧跟在一段没有工具调用的完整回复之后、中间没有你的消息），不加事件 | 内网端点上常见时；你走查时 |
| 检查之前调的 `finish` | 不算确认，照样检查一次；`finish` 在用户会话里一直启用，协作模式下 `mori-team` 设对话会话的工具时也留着 | proposal §5.4、§6.1 | 检查是为了收尾时再看一眼 TASTE、REVIEW；只在检查时启用的话，启用的工具一变 pi 就记 system 补丁，前缀缓存失效 | — |
| 运行中进来新的消息 | 排队或插话的消息进了上下文，检查计数从头算 | proposal §5.4 | 那是对新消息的新回复，同样该检查；从上下文里数自然就是这样 | — |
| 增强任务的看不见的会话 | 不注册 `finish`，也不检查 | proposal §6.1、§9 | TASTE 管的是怎么和你说话，它用不上；要加就得把修订记录的 Notes 改成最后一段非空文字（记忆规格 §9.8）。代价：它说要改条目却没调 `memory` 就停了，会记成一次正常的“没有改动”，不重跑 | 增强运行常常说了要改却没改时 |
| 按模型能力过滤 | 不在选择器之外另加过滤 | proposal §8 | 选择器已经只让工具调用验证过的模型进会话（模型层规格 §5.3 第 3 步）；负责人定每次运行都检查 | 真实模型走查里有服务调不通没有字段的工具时 |
| 检查那次请求的思考强度 | 用会话的，不另降 | proposal §10 | 对照 REVIEW 判断做没做完需要思考；不另加一条按请求改强度的规则；对按 `budget_tokens` 或顶层 effort 发强度的 Claude 模型，另降会让检查那次请求的消息缓存失效 | 走查量出检查的思考 token 占得多、收尾拖得太久时 |
| 开关 | 不加 | proposal §9 | 负责人定每次运行都检查；能满足需求的最简单做法 | 你想关掉它时 |
| 检查块的形状与位置 | 接进检查那一行（同一条消息）；和“你不在时”的提醒同时要加时，顺序是 [检查那一行，提醒，工作卡]，只多一次请求 | proposal §5.5、§10 | 连着两条 user 消息会被要求严格交替的聊天模板拒绝；扩展顺序本来就把检查那一行排在提醒之前，块和行贴在一起规则最简单；工作卡照平行 Agent 规格总在最后 | 写规格时 |
| Customize 页列不列 `finish` | 列出，同 `memory`：来源 Mori，说明的第一行写成人看得懂的一句 | proposal §11 | 状态有来源，模型确实有这个工具；pi 的 `hidden` 会让工具不能调用，按名字藏又多一个特例 | 你走查工具页时 |
| 回复下的操作行什么时候出现 | 照现在的规则，这一轮结束（检查之后）才出现 | proposal §8、§11 | 回复要过了检查才算最终回复；不另加“看起来写完了就先显示”的规则 | 你走查时觉得 Copy 出来得太晚时 |
| 重写之后的显示与 Copy | 两段都显示；Copy 和“Attach message as context”仍取整轮的正文 | proposal §5.3、§11 | 同 Stop hook 让模型接着写时的情形；改 Copy 的范围会影响所有多工具的轮次；想只复制最终回复可以在折叠那一步一起定 | 做折叠那一步时 |
| 检查那次请求换模型 | 跟在没有工具调用的助手消息之后的请求（检查、你不在时的提醒）换模型时，不隐藏、不加重做说明（改模型层规格 §6.1） | proposal §8、§10 | 回复已经完整，没有中断的过程可重做；隐藏了换到的模型就看不到要检查的回复，只能重做一遍或盲确认 | 写规格时 |
| 检查计数怎么得到 | 不另存状态：每次运行要结束时，从这次运行的上下文里数（最近一条用户消息之后有几行检查、最近一行检查之后调了什么） | proposal §5.4、§6.3 | pi 在同一次运行里每次接着跑都再发 `agent_start`，按它清零会让检查没有上限；从上下文数不受影响，排队、插话和停止后留下的旧检查行也自然处理 | 写规格时 |
