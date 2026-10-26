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
| 压缩请求超时后模型不可用（`timeout`）（2026-10-26 改：原来写“超时后已验证取消的模型不可用”，负责人走查 M7 删掉取消测试后，会话请求超时总是等满 `held`，这个时长只剩压缩请求用，规格 §6.4） | 60 秒 | `app/src/kernel/modelTimings.ts` | 刚超时的模型短时间内多半仍慢，避开一会儿再试 | 你走查时 |
| 发出后超时的模型等它停下（`held`）（2026-10-26 改，负责人走查 M7：原来是“超时后不能确认停止的模型等它停下 / 读指标确认的间隔 2 分钟 / 5 秒”；取消测试删掉后不读指标，每次都等满） | 2 分钟 | `app/src/kernel/modelTimings.ts` | 保证同一个请求不同时在两个模型上跑（proposal §8、§12 第 4 条）；2 分钟足够大多数生成被服务端的超时结束；负责人的决定写明“after a timeout Mori always waits 2 minutes before switching” | 拿到内网端点、知道它断开后是否停止时 |
| 候选耗尽时最长等 / 重新选的间隔 | 60 秒 / 5 秒 | `app/src/kernel/modelTimings.ts` | 限流冷却多在一分钟内；再久不如告诉你、让你去设置；除了到点和探针结束，每 5 秒再看一次 | 你走查时觉得等得太久或太短 |
| 探针最大输出 / 每一步等第一个有内容的事件 | 256 token / 120 秒（2026-10-26 改：去掉“第 9 步 2048”，第 9 步已删掉） | `app/src/kernel/modelTimings.ts` | 探针只要短回答；推理模型先输出思考，太小时收不到正文；时长同对话请求 | 拿到内网端点时 |
| C 级文本标签连发次数 | 3 | `app/src/kernel/probes.ts` | 连续几次都能解析才算稳定，又不多花请求 | 内网模型的 C 级判定不稳时 |
| 4xx、5xx 响应体最多读 | 64 KB | `app/src/kernel/modelPool.ts` | 分类只需要错误信息；限量防止异常的大响应占内存 | — |
| 迁移时 `maxTokens` 缺失 / 不小于窗口 | pi 的默认 16384 / 窗口的一半 | `app/src/kernel/modelMigrate.ts` | 与 pi 自己的默认相同；v1 要求 `maxTokens` 小于窗口，取一半给输入留地方 | 你走查迁移结果时 |
| 新模型表单的 Max output | 16384 与窗口一半中较小的 | `app/src/renderer/src/components/`（模型表单）；2026-10-23 起模型表单只剩 Edit，这条规则用在清单里没报告的值和手填的行（见下面“一键拉取模型”一节） | 同上一行的理由，与迁移一致 | 拿到内网端点时 |
| 兼容选项的标签与说明 | 六个勾选框，标签写端点的情况，下面一行小字写勾了之后 Mori 怎么发请求，例如“Endpoint needs max_tokens instead of max_completion_tokens” / “Older endpoints don’t recognize max_completion_tokens”；全文见规格 §9.1；提供商卡上只列标签。2026-10-26 改（负责人走查 M1）：只剩五个，“Endpoint doesn’t support strict mode for tool parameters”删掉（pi 1.3.0 默认就不发 strict；配置里存着的照样读得出，界面不显示）；图例下面一行说明“Mori already adjusts requests for well-known services such as DeepSeek. Check an option only if this server rejects requests.”；提供商卡上的“Compatibility options”只对 OpenAI-compatible 显示 | `app/src/shared/models.ts` `COMPAT_LABELS`、`COMPAT_HINTS`；`app/src/renderer/src/components/settings/fields.tsx` `CompatChecks`（提供商表单与首次启动表单共用） | v0 方案 5.2 要求每项配说明；沿用 english-ui 的英文（[v0/ui-strings.md](../v0/ui-strings.md)），v1 合并时一度只有规格原来的短标签、没有说明，2026-10-21 改回。图例下的一行说明是 2026-10-26 加的：负责人以为拉取模型会自动勾这些选项，而 DeepSeek、z.ai 这些服务 pi 按地址自己调整，什么都不用勾，原来界面没说（诊断 M1） | 你走查设置页与首次启动时；拿到内网端点时 |
| pi 里的占位 `apiKey` | `mori-pool` | `app/src/kernel/modelCompile.ts` | pi 要有 key 才把提供商当作已配置（K1）；不保密，真正的 key 由模型池写进认证头，占位不会发到服务端（MP-32） | pi 升级时 |
| 重做说明文字、各提示文字 | 规格 §6.1 的重做说明，§9 的界面文字 | `app/src/kernel/modelContext.ts`（重做说明）；`app/src/renderer/src/components/`（提示、阶段行、说明卡、拒绝启动卡） | 重做说明要让新模型知道前半段被隐藏、工作区可能已改；英文给模型读最稳 | 内网模型对英文说明的理解不好时；你走查时 |
| 思考关不掉的模型在探针里用的强度（2026-10-24 补） | `medium`（同第 1 步与第 4 步的回传检查），按哪一份判定用它分两组（规格 §7.7）：第 1–7 步（一组自动探针）都在一份没有“没有 Off”标记的模型副本上发，**这一组**第 2 步判出 `off_refused` 时第 3、4、6、7 步用 `medium`、第 5 步不适用（第 7 步照第 6 步的结果决定跑不跑），没判出时同原来（`off`），不看档案里存的；第 2 步照旧分别用 `off` 和 `medium`（2026-10-26 删：原来还有“第 8、9 步（需要你同意，单独一组）用编译后的模型，按档案里存的 `off_refused` 选”，这两步已删掉） | `app/src/kernel/probes.ts` | 这类模型关闭思考被服务拒绝（400），探针只能开着思考测；用第 1 步和回传检查已经在用的 `medium`，不另加一个值。第 1–7 步按本组第 2 步而不按档案：已经标记过的模型点 Verify 时第 2 步重新测，这一次判出能关闭时第 3–7 步也确实关闭思考；第 8、9 步不跑第 2 步，这时编译后的模型与档案一致，只能按档案（2026-10-26 删：第 8、9 步已删掉，这半句只是原来的理由，见 [WP-04](walkthrough-1026/WP-04.md)，负责人走查 M7 决定 1）。2026-10-24 在 OpenRouter 上实测（[models-checks.md](models-checks.md)“思考关不掉的模型：实测”）：`recursive/flint-v1.0:free` 在 `medium` 下第 3、4、6 步通过、第 7 步连发 3 次都通过，`liquid/lfm-2.5-2.6b:free` 第 3、4、6 步通过；`medium` 不在模型列出的强度里时 OpenRouter 也不拒绝（`z-ai/glm-5.3-flash` 列 `[max, high, low]`，收 `medium` 是 200、正常回答） | 拿到别的服务（Anthropic、百炼、MiniMax、内网部署）上必须思考的模型时；`medium` 下探针常停在输出上限时 |
| 测试连接的思考强度（2026-10-24 补） | 勾了 Supports thinking 的模型带 `medium`（同探针第 1 步），没勾的不带（规格 §7.7） | `app/src/kernel/config.ts`（`testConnection`） | 不带强度时 pi-ai 在 OpenRouter、DeepSeek、z.ai、Together 的地址和 `openai-responses`、`anthropic-messages` 上写成明确的“关闭思考”，必须思考的模型回 400，第一次探测之前的测试连接就失败；带 `medium` 不用等档案。2026-10-24 实测（[models-checks.md](models-checks.md)“思考关不掉的模型：实测”）：两个必须思考的模型用 `medium` 问第 1 步那一句都是 200、回答“ready”，关闭思考（`reasoning: { effort: "none" }`）时都回 400 `Reasoning is mandatory for this endpoint and cannot be disabled.` | 测试连接因为开着思考明显变慢时；拿到别的服务上必须思考的模型时 |
| 探针回复停在输出上限、只有思考（2026-10-24 补） | 回复因输出上限停下（`stopReason` 为 `length`），没有正文也没有工具调用、只有思考时，这一步按出错处理，说明“Stopped at the probe output limit before answering”；对所有模型的第 1–7 步（2026-10-26 改：原来是第 1–9 步，“第 8 步也不因此记 `silent`”随第 8 步删掉）；不判为不通过；探针最大输出仍是 256 token（规格 §7.7） | `app/src/kernel/probes.ts` | 开着思考时 256 token 可能全花在思考上，这不是模型做不到：判为不通过会把能用的模型标成失败，第 8 步还会误记成静默截断（2026-10-26 删：第 8 步已删掉，见 [WP-04](walkthrough-1026/WP-04.md)）；按出错处理，说明看得出是输出上限。2026-10-24 实测（[models-checks.md](models-checks.md)“思考关不掉的模型：实测”）：`liquid/lfm-2.5-2.6b:free` 在 `medium` 下第 7 步连发 3 次都停在 256 token（`finish_reason: length`），只有约 900 字思考、没有正文；它第 6 步已通过（B 级），真实探测时第 7 步不跑，所以最大输出维持 256，不为这一种情况调大 | 内网或别的服务上的思考模型常因此出错、需要调大探针最大输出时 |
| 拖动排序（2026-10-26，负责人走查 M5，规格 §9.1“拖动排序”） | Keys、Models、分组成员三个列表都用拖动（诊断的推荐）；柄在行的左端，只有一行时没有；鼠标在一行的上半边插在它前面、下半边插在它后面，线是那一行上沿或下沿 2px 的强调色，被拖的行变淡；焦点在柄上按上、下方向键一次移一格并保存，焦点留在这一行的柄上（保存失败、回到原位置时也是）；读屏名、悬停与播报用 Claude 的“Reorder {name}”“Drag or use the arrow keys to reorder”“{name} was dropped at position {position} of {count}.”，成员的名字里“ · ”换成“, ”；保存中柄不响应；Models、Keys 移动失败的原文在列表下面 | `app/src/renderer/src/components/settings/Reorder.tsx`（柄、放下的位置、播报、`useOrderedSave`）；`ModelRows.tsx`、`Keys.tsx`、`Groups.tsx`；`app/src/renderer/src/styles/models-settings.css`（拖动排序一节）；`app/src/shared/models.ts` `movedItems`（界面的新顺序与后台进程 `modelCommands.ts` 的 `moved` 共用） | 负责人要拖动、不要箭头按钮；原生拖放同 `SessionDrag.tsx`，不加依赖；方向键是键盘用户唯一的路，一次一格就保存最简单（Claude 的“拿起、移动、放下”模式要四句播报和一个拿起状态，这里不需要）；一次放下一条命令，三格也只写一次配置、编译一次 | 你走查设置页时；觉得方向键应先拿起再放下时 |

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
| Task mode 开关的位置与样子（2026-10-26，WP-09） | 模型菜单里范围的几节和说明之下、`Manage models` 之上的一行 `Task mode`（`menuitemcheckbox`，右边画一个开关）；点了菜单不关、焦点留在这一行；`always` 的第二行 `Messages go to <create role> first`，`once` 的第二行 `Until done · Ends when open requests are done`，`off` 没有第二行；切换中这一行不可用（`aria-disabled`，焦点留在这一行） | `app/src/renderer/src/components/TeamSwitch.tsx`、`ModelMenu.tsx` | 负责人走查 M10 要把开关放进模型菜单；Claude 的 Fast mode 开关也在模型菜单里；菜单往上打开，这一行离按钮近；点了不关菜单，看得到范围的几节换成说明 | 你走查时 |
| 模型按钮上的模式（2026-10-26，WP-09） | 协作模式下 `Task mode · <当前模型 id>`（没有当前模型时 `Task mode`），跟着 `TeamState.mode`（不等 `pickLocked`）；悬停第二行 `Task mode picks the model for each agent` | `app/src/renderer/src/components/ModelMenu.tsx` | M10 的推荐选项“Text on the button”：开关不在顶栏后，不打开菜单也要看得出模式；放不下时先截模型 id、再截 `Task mode`（同范围按钮） | 你走查时觉得太长、想要图标时 |
| 回复进行中的模型菜单（2026-10-26，WP-09） | 能打开；范围的项不可用（`disabled`），说明换成 `Can’t switch models until the response finishes`；Task mode 一行可用 | `app/src/renderer/src/components/ModelMenu.tsx` | M10 的推荐选项：§13.1 本来允许回复中切换模式，开关进菜单后菜单要能打开 | 你走查时 |
| Task mode 切换失败那一行（2026-10-26，WP-09） | `Couldn’t change task mode: <原文>`；菜单开着时在 Task mode 一行下面，关着时从输入框下面一行往上弹出（同换范围失败）；10 秒后或下次切换时消失 | `app/src/renderer/src/components/TeamSwitch.tsx`、`app/src/renderer/src/state/teamActions.ts` | 原来在顶栏开关下面；菜单开着时往上弹出的一行会被菜单挡住 | 你走查时 |
| 给 `conversation`、`decision` 留的槽位 | 每个 key 1 个（`task`、`background` 最多占并发上限 − 1；并发上限为 1 时不留；普通模式 subagent 的类别 `subagent` 不受它约束，subagent 规格 §5.4） | `app/src/kernel/modelPool.ts` | 严格优先不打断已经发出的请求；不留的话 4 个 task 占满默认的 4 个槽位，对话和立项等到超时 | 拿到内网端点、知道它的并发时 |
| 命令与界面名 | 命令 `/task`、`/task on`、`/task off`（2026-10-26 由 `/team` 改，负责人走查 M21，没有别名；给模型的文字叫 task mode）；界面 `Task mode`、`Turn off task mode`、`Stop agents`（2026-10-26 负责人走查 M21，原为 `Team`、`Turn off team mode`、`Stop team`） | `app/src/renderer/src/`（命令 `state/teamActions.ts`）；给模型的文字 `app/src/kernel/boardText.ts` | 命令是 proposal 的暂定名，`/task off` 为派生；界面名按负责人的回答 | 你走查时 |
| 关闭模式的工作卡列出的需求 | 最近 5 个；更早的写成一行 `N earlier requests: board_read {}` | `app/src/kernel/boardText.ts`（`OFF_CARD_REQUESTS`） | 关掉 Task mode 之后每次请求都带这张卡，列太多费 token；更早的用 `board_read {}` 看得到（2026-10-26，WP-10） | 你走查时 |
| 基座的一句话说明 | `General-purpose agent with the default tools` | `app/src/shared/team.ts`（`BASE_ROLE_DESCRIPTION`） | 基座没有角色文件，`next`、`assignee` 的说明与附加段的“Other roles”要一句话；规格没给 | 你走查时 |
| Background tasks 的页签出现的条件（2026-10-26） | 会话的 TaskBoard 有需求，或协作模式不是 off；否则右栏与原来相同 | `app/src/renderer/src/components/ChangesPanel.tsx` | 没用过协作模式的会话保持 v0 的样子（TB-03）；模式打开、还没有需求时能看到 Background tasks 在哪 | 你走查时 |
| 阶段行按钮的计数（2026-10-26） | 有 pending、active、waiting_user 的 task 时 “{n} running tasks”（这几种的个数），否则 “{n} tasks finished”（全部 task 数，含 stopped） | `app/src/renderer/src/state/taskList.ts`（`tasksButtonText`） | Claude 的按钮按“还在跑 / 都结束了”两种写；Mori 的 stopped 不会自己再开始，算在结束一边 | 你走查时 |
| Background tasks 两节的顺序与折叠（2026-10-26） | Running 按编号从小到大，Finished 按编号从大到小；Finished 默认展开，可以折叠 | `app/src/renderer/src/state/taskList.ts`（`taskSections`）、`app/src/renderer/src/components/BackgroundTasks.tsx` | Running 照拆分的先后读；刚结束的在 Finished 最上面；负责人选了 Claude 的两节 | 你走查时 |
| task 视图与运行中会话的重新读取（2026-10-26） | 这个 task 的 TaskView 在 mori.board 里变了时重新读，最多每秒一次 | `app/src/renderer/src/state/taskList.ts`（`REREAD_MS`、`rereadWait`） | 实例每次工具调用都会改 TaskView（最多每 250 毫秒一次）；会话文件可能有 1 MB（Har-GUI 的 T4），每秒一次足够跟上又不反复传大块 | 你走查时觉得慢；会话很大时 |
| 交接的结果与去向的英文（2026-10-26） | Continue、Dead end、Blocked、Needs your decision、Done、Pass、Fail、Closed as done、Closed as failed；→ <role>、→ <close role> (closing)、→ <create role> (planning)、→ Done、→ Failed | `app/src/renderer/src/state/taskList.ts`（`OUTCOME_TEXT`、`routeText`） | 规格以前只在 board_read（给模型）里写结果的代码；界面要人话，Claude 没有对应 | 你走查时 |
| Background tasks 里基座的名字（2026-10-26，负责人不在时按推荐定） | 项目没有角色文件时也照 §13.13 写 `Mori`（卡片第二行、task 视图、交接的头一行与去向、会话标题）；进展摘要照 WP-10 的 #64 不写 | `app/src/renderer/src/state/taskList.ts` | #64 只管进展摘要；Background tasks 一栏本身说明这些是后台的 task，谁拿着它是要看的事实；不写的话 §15 还要一套不带角色的去向（team-checks.md Background tasks #5） | 你确认 #64 时 |
| 模型菜单 Task mode 那一段的先后（2026-10-26，customize-agents 合入后） | Task mode 一行、它的失败行、`See background tasks`（有需求或协作模式打开时）、`Manage agents`，再下面 `Manage models` | `app/src/renderer/src/components/ModelMenu.tsx` | 两个 “Manage …” 挨着，都是去别的页；`See background tasks` 看的是 Task mode 的状态，挨着 Task mode 一行（team-checks.md Background tasks #10） | 你走查时 |
| 分屏时点没有焦点那一栏的 `{n} running tasks`（2026-10-26，审查 #15） | 同右栏开关：鼠标主键按下时不切焦点，这一下点完（或在别处松开）才切到那一栏 | `app/src/renderer/src/components/ChatPane.tsx`（`isTopBarAction`）；[split.md](../v0/screens/split.md)“右栏开关” | 按下就切的话右栏先换成那一栏的状态、两栏变宽，按钮被挤走，这一下点空；同右栏开关的例外 | 你走查分屏时 |
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
| `agent` 调用方的 `save`、`update` 要带 `quote` | 必填 | `app/src/kernel/memoryRules.ts`（toolFieldError）、`app/src/kernel/memoryText.ts`（说明与 Correct form） | proposal §8.1 的依据是你的原话；主动记的（2026-10-26）也一样，是你说出事实或纠正它的那句话 | 你走查对话里记一条、真实模型常漏写原话时 |
| 在记忆页改一条“它学的”或“Mori 记的” | 改后为 `You said`，之后增强不能再改它 | `app/src/kernel/memory.ts` | proposal §4 把你手写的算“你说的”；要退回可以回滚这次修改 | 你走查记忆页时 |
| memory 工具没给 `asked`（2026-10-26，规格 §6.4、§12） | 按 `false`：记下的条目算 Mori 记的（`source: agent`，`Added by Mori`） | `app/src/kernel/memoryRules.ts` `sourceAfter`；`app/src/kernel/memoryTool.ts`（schema） | 标错成“你说的”会让增强永远改不了它；标成 Mori 记的，最坏是增强改了它或把它移到别的种类，你的原话还在、可以回滚 | 真实模型走查（mem-real 的 dialog）里模型常把“记一下”的话也漏给 `asked` 时 |
| Mori 主动改一条“你说的”（2026-10-26） | 仍是 `You said`；`asked` 为假时只把 `learned` 改为 `agent` | `app/src/kernel/memoryRules.ts` `sourceAfter` | Mori 自己改不该把你说的条目交给增强 | 你走查时 |
| 增强把 Mori 记的条目移到另一种（2026-10-26，规格 §6.9） | 只移本项目 `agent` 条目、这次运行的种类是一端；不要求依据；slug 不变（`<kind>-<日期>-<4 位>` 里的旧种类名照留）；加在目标种类末尾，回滚回到原种类末尾 | `app/src/kernel/memory.ts`（`update` 带目标种类）、`app/src/kernel/memoryRules.ts`（`writeRefusal`、`mergeRunChange`）、`app/src/kernel/memoryTool.ts`（`move`） | 移动不改条目的内容，你的原话与原来的依据都在；要求新依据会让前几天记的条目永远移不动；改 slug 要改文件名和 `[[slug]]` 链接 | 你走查重新归类、觉得移动也该带依据时 |

## Customize › Agents

来源：[Customize › Agents 规格](../specs/customize-agents.md) §7（2026-10-26，走查 M20）；状态表 [screens/customize-agents.md](screens/customize-agents.md)。

| 默认值 | 取值 | 位置 | 理由 | 何时复查 |
| --- | --- | --- | --- | --- |
| 三项职责的界面文字 | `Talks to you`（dialog）、`Plans requests`（create）、`Closes requests`（close） | `app/src/shared/roles.ts` | 界面不讲 seat 这个行话；用这个职责做什么来叫它 | 你走查 Agents 一节时 |
| 候选能用的文字 | `Ready` | `app/src/shared/roles.ts` | 只是静态检查通过，不说 “Available”（那要看此刻的限流与连接） | 同上 |
| 要求的白话 | `Fills in handoff forms (verified)`、`Handoff tier B or better`、`Structured output (verified)`、`Image input`、`Context window of at least N tokens` | `app/src/shared/roles.ts` | 词表（TaskBoard 规格 §4.1）是文件的写法，界面写白话；原因原文仍照选择器 | 同上 |
| 分节位置 | Skills 之后 | `app/src/renderer/src/components/ToolsPage.tsx` | Claude 的插件详情里 Agents 排在 Skills、Commands 之后；也让它不挨着 Instructions（AGENTS.md）一节 | 同上 |
| 新文件的写法 | `description` 写 JSON 字符串；列表单行 `[a, b]`，含字母、数字、下划线、`._/-` 以外字符的项写 JSON 字符串，YAML 会读成 null、布尔或数字的值（`true`、`302`、`1e3` 等，`name` 也一样）同样写 JSON 字符串（2026-10-26 评审）；`subscribe` 写 JSON | `app/src/kernel/roleFiles.ts` | JSON 是 YAML 的子集，不用新增 YAML 依赖，读回与手写的文件同一个解析器 | 你想要更像手写的格式时 |
| 编辑时的文件名 | 不随名字改 | `app/src/kernel/roleCommands.ts` | 手写的文件名可以和 name 不同；改名只改 name，不挪文件 | 同上 |
| 删除 | 直接删除，不进回收站 | `app/src/kernel/roleCommands.ts` | 同删除会话（照 Claude：确认后永久删除） | 同上 |
| 编辑时文件头的注释 | 不保留，表单上方提示 | `app/src/kernel/roleFiles.ts` | JSON 写法写不出注释；按字段重写比逐行修补简单 | 你的文件里常写注释时 |
| 本节的说明与空状态 | 规格 §6.1、§6.2 的文字 | `app/src/renderer/src/components/ToolsAgents.tsx` | 规格没给的界面文字 | 你走查时 |
| All MCP tools 写进文件的样子 | `mcp__*`（全部 MCP 工具；TaskBoard 规格 §4.1 为它放开） | `app/src/kernel/roles.ts`（tools 的校验） | 与基座的白名单同一个写法，以后加的 MCP 服务也算在内；另两个做法是表单不提供它，或按此刻的服务各写一个 `mcp__<服务>__*`（2026-10-26 已问负责人） | 负责人回答时 |
| 表单没有勾选框的工具写法（2026-10-26 评审，推荐，负责人不在时照用） | 不显示、不改，勾或取消别的项时原样留着，保存时写在列表后面（例如 `tools: [read, grep, "mcp__github__*"]`） | `app/src/shared/roles.ts`（`toolsToggled`）、`app/src/renderer/src/components/ToolsAgentForm.tsx` | TaskBoard 规格 §4.1 允许按服务写 MCP 工具；表单只给全部 MCP 工具一个勾选框，原来勾选时按勾选框重排会悄悄丢掉它们。另两个做法：给每个这样的写法加一个勾选框（新的界面行），或保存前提示会去掉 | 你走查 Agents 一节、或要在表单里选单个 MCP 服务时 |
| Add model range 的节（2026-10-26 评审，推荐，负责人不在时照用） | Groups、Providers，再按提供商各一节 `Models · <提供商名称>`，顺序同模型菜单；没有项的节不出现 | `app/src/shared/roles.ts`（`rangeGroups`）、`app/src/renderer/src/components/ToolsAgentForm.tsx` | 模型菜单的 Models 一节按提供商分小节；`<optgroup>` 不能套，拼成一个节名。原来只有一个 Models 节、只写模型 id，同名的模型分不出是哪个提供商的。另一个写法：节名只写提供商名称 | 你走查时 |
| 范围展开不出模型时的一句话（2026-10-26 评审，推荐，负责人不在时照用） | `No model can run this agent`（同全部不能用）；`No model range picked` 只在没写 models、会话又没有范围时 | `app/src/shared/roles.ts`（`modelLine`） | 例如项目的 `.mori/models.json` 读不出时会话有范围、候选却为空，原来误报 “No model range picked”。另一个做法：再加一句专门的话 | 你走查时 |
| Only these 一个都没勾时的 Save（2026-10-26 核对，推荐，负责人不在时照用） | 文件里有表单外保留的条目（例如 `mcp__github__*`）时仍可用，保存后 `tools` 只有这些条目；没有时不可用 | `app/src/renderer/src/components/ToolsAgentForm.tsx`（`canSave`） | 保留的条目就是这个 agent 的工具，为了能保存逼人勾一个会改掉文件。另一个做法：只看勾选框，一个都没勾就不能保存 | 你走查时 |

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
| 没报告时的窗口 / 输出上限 | 128000 / 16384 与窗口一半中较小的；清单里标 “Not reported”（2026-10-26 改，负责人走查 M6：值仍等于这个默认值时清单里标“Default”、模型行标“(default)”，悬停说明“The server didn’t report this, so Mori used a default.”后面分别接“Change it if you know the real value.”“Use Edit to set the real value.”；改成别的值就不标） | `app/src/shared/models.ts`（`UNREPORTED_CONTEXT_WINDOW`、`unreportedMaxTokens`，2026-10-23 实现时放在这里，一份规则两边用）：`app/src/kernel/discoverRead.ts`（读一行、§4.3 的最后检查）与界面都用它：清单里手填的行（`app/src/renderer/src/components/settings/Checklist.tsx` `enteredRow`）、改窗口时（`Checklist.tsx` `followWindow` 经 `fields.tsx` `defaultMaxOutput`）、模型行窗口提示的 Use（`settings/ModelRows.tsx` `sizeHints`，规格 §8） | 同模型层规格 §12（pi 的默认、原来新模型表单的 Max output）；不查 pi 的模型目录、不按名字猜（proposal §12 第 2 条），由探针与长输入测试再核实（2026-10-26 注：长输入测试删掉之后（WP-02 删按钮，WP-04 删探针），没有东西再核实这个窗口，只靠标记提醒你用 Edit 填真实值；按地址取 pi 模型表的改动见负责人的回答 1，WP-15） | 同模型层“新模型表单的 Max output”一行；拿到内网端点时 |
| 取自 pi 模型表的标记与提示的文字（2026-10-26，负责人走查回答 1，WP-15） | 清单“From pi”，模型行“ (from pi)”；清单的悬停说明“The server didn’t report this, so Mori used pi’s model list for <provider>. Change it if you know the real value.”，模型行的“The server didn’t report this; pi’s model list for <provider> has the same value. Use Edit to set the real value.”（2026-10-26 审查后改：模型行的标记只看值相同，你手设的值也会标）；模型行三条提示“pi’s model list for <provider> has a context window of <N>.”“pi’s model list for <provider> has max output of <N>.”“pi’s model list for <provider> says this model supports thinking.”，只在配置仍是默认值时出现；<provider> 用 pi 的提供商显示名 | `app/src/renderer/src/components/settings/Checklist.tsx`（`piTitle`、`isFromPi`、`PiMark`）、`settings/modelHints.ts`（`piRowTitle`、`valueMarks`、`piHints`），`settings/ModelRows.tsx`（`PiMark`）显示 | 回答只说按地址取 pi 的值、仍是猜的值标 "(default)"，没定取来的值怎么标；与“Default”“(default)”写法平行，悬停写出是哪一家的条目；Claude 桌面版没有对应。提示只给仍是默认值的模型（手填的行、以前加入的模型），你设过的值不提示改成 pi 的 | 负责人走查清单与模型行时 |
| pi 模型表取哪几项、怎么对上（2026-10-26，WP-15） | 只取窗口、最大输出、是否支持思考（为真时），只取服务没报告的项；最大输出要小于这一行的窗口；同一 origin、id 完全相同（区分大小写）才对上，路径与 API type 不比；一个 origin 下几个条目不一致时不取；图片输入不取 | `app/src/kernel/piCatalog.ts`（`catalogEntry`）、`app/src/kernel/discoverRead.ts`（`fromCatalog`） | 回答列了三项（上下文窗口、最大输出、是否支持思考），图片输入没列，按原话不取；按地址不按名字，所以要 origin 相同；z.ai 的 Anthropic 地址与 pi 的 Z.AI 条目路径、接口都不同，只能比 origin；id 不改大小写，免得两个服务把大小写不同的 id 当成不同模型时取错 | 负责人走查时；pi 升级、模型表的地址或字段变了时 |
| 名称 | 主机名，端口不是协议默认端口时加 `:<端口>`（例如 `api.deepseek.com`、`10.0.0.5:8000`） | `app/src/kernel/discoverRead.ts` | 主机名就认得出是哪个服务；同一台机器上的几个服务靠端口区分；拉取后可以改 | 你走查时 |
| 探针代价的说明 | “Each model is verified with up to 13 short requests.”（自动探针第 1–7 步最多 13 个请求） | `app/src/renderer/src/components/settings/`（Add provider 和卡上清单的底部，Add 按钮上方；首次启动表单在 Test connection 上方，规格 §6.6） | proposal §12 第 5 条：加入的模型全部自动跑探针，清单底部写明代价；在公网云上会花一点额度 | 探针步骤变化（`PROBE_SUITE` 改版）时 |
| 清单的默认勾选 | 服务报告是聊天模型（`chat` 为真）的勾上，报告不是的不勾；不报告类型（`chat` 为 null）时，能加入的行只有一行就勾上，否则都不勾；Added、不能加入的行不勾 | `app/src/renderer/src/components/settings/Checklist.tsx` | proposal 已定（§12 第 1、4 条）：只按服务报告的类型判断，不按名字猜；OpenAI 这类不报告类型的列表里混着 embedding、语音和图片模型，全勾会加入不能对话的模型，所以只有一个时才勾，其余用 Select all | 你走查清单、常要手动 Select all 或取消勾选时 |
| 列表地址最多试 3 次 | 没有 Anthropic 提示时最多 2 个（`<base>/models`；base 不以 `/v<数字>` 结尾时再试 `<base>/v1/models`）；有 Anthropic 提示时最多 3 个（`<base>/v1/models?limit=1000`、前缀 + `/models`、前缀 + `/v1/models`；主机是 `api.anthropic.com` 时只有第一个）；已有提供商不整理地址：`openai-*` 只试 `<baseUrl>/models`，`anthropic-messages` 同有 Anthropic 提示时的三个（前缀取 `baseUrl` 路径里 `anthropic` 那一段之前的部分；主机是 `api.anthropic.com` 或路径里没有这一段时只试第一个）；拿到列表、401/403 或连接失败、超时即停 | `app/src/kernel/discoverRead.ts`（列表地址的计划） | 补 `/v1`、去掉 `anthropic` 那一段对应 proposal §5.1、§5.3 写的两种常见填法（一键拉取模型 proposal 要求的功能，不算 fallback）；不再往下猜更多路径；认证失败和连不上时换地址也没用 | 遇到列表在别的路径上的服务时 |

## 普通模式的 subagent 工具

来源：[普通模式的 subagent 工具规格](../specs/subagent.md) §10；检查记录见 [team-checks.md](team-checks.md) 的“普通模式的 subagent 工具”一节。

| 默认值 | 取值 | 位置 | 理由 | 何时复查 |
| --- | --- | --- | --- | --- |
| 一次调用、一次回复的 subagent 数 | 不设上限 | — | 负责人 2026-10-26 定（“as many as main agent want”）；同时在途的请求只受每个 key 的并发设置约束 | 走查中碰到一次开太多、内存或上下文吃紧时 |
| `description` / `prompt` 长度 | 1–80 / 1–8000 字符 | `app/src/shared/subagent.ts` | 描述是卡片上的一行（同 task 标题 80）；提示要能把背景写全，比 Agent 消息的 4000 宽一些 | 你走查时 |
| 结果里每个回复的长度 | 16000 字符，超出截掉并注明 | `app/src/kernel/subagent.ts` | 每个回复约 4000 token 以内；几个回复一起进主 Agent 的上下文，小窗口的模型也放得下 | 内网小窗口模型上看到效果时 |
| 调度类别 | `subagent`：严格优先排在 `decision` 之后、`task` 之前；不受“留一个槽位”的限制；不排队超时 | `app/src/kernel/modelPool.ts`、`app/src/kernel/team.ts`（`schedClassOf`） | 负责人 2026-10-26 定“用满并发设置”；`conversation` 类别等槽位超过 60 秒会换模型或失败，subagent 多于槽位时要能排队等 | 拿到内网端点、知道它的并发时 |
| 进展的合并发送间隔 | 250 毫秒 | `app/src/kernel/subagent.ts` | 同 `mori.board`：工具调用很密时不刷屏 | — |
| 行里失败原因的显示长度 | 80 字符，悬停看全文 | `app/src/shared/subagent.ts`（`SUBAGENT_LIMITS.failure`、`failureText`）、`app/src/renderer/src/components/subagentView.ts` | 一行放得下 | 你走查时 |
| 卡片的展开 | 执行中展开，结束时收起一次 | `app/src/renderer/src/components/SubagentCard.tsx` | 执行中看得到每个 subagent 在做什么；结束后只占一行（走查 M18 要的“结束后折起来”） | 你走查时 |
| 界面文字 | 规格 §7、[subagent-card.md](screens/subagent-card.md) | `app/src/shared/subagent.ts`、`app/src/renderer/src/` | 照 Claude 桌面版的用词 | 你走查时 |
| 原来的准则（什么时候用、每个 prompt 要能单独看懂）放在哪里 | 并进工具的说明第三行，不写 `promptGuidelines`（规格 §6.1、§6.4） | `app/src/kernel/subagent.ts`（`SUBAGENT_DESCRIPTION`） | 说明在工具定义里，不算身份段；这样默认工具下的普通模式身份段正好 500 token，守住记忆规格的上限（MEM-01）；Claude Code 也把这类指引写在工具说明里。另外两种：保留准则（普通模式 549 token，超过上限）；缩短准则（522 token，仍超过） | 你回来看时（2026-10-26 你不在，按推荐定；记录在 team-checks.md“要你决定的”第 1 条） |
| 交出去的活那一句（身份段，记忆规格附录 A.1.1） | 按这次运行启用的 `task_create`、`agent_message`、`subagent` 拼（规格 §6.4）；同时有 `task_create` 与 `agent_message` 的会话（Task mode 的合并会话、分开时的立项）与 WP-11 逐字相同，Task mode 下只有 `agent_message` 的（分开时的对话，task、结案、订阅实例）改为只说问题的那一句 | `app/src/kernel/memoryText.ts`（`handoffText`） | 固定的句子在普通模式下说的是不存在的工具，模型会把事实写进卡上的标题而不是 `prompt`。另外两种：照旧用固定的句子；普通模式不加这一句 | 你回来看时（2026-10-26 你不在，按推荐定；记录在 team-checks.md“要你决定的”第 2 条） |
| `role` 参数的写法（有别的角色时） | 字符串，不写枚举；说明里列出角色（规格 §3.1）；写错的角色由 §3.3 的检查给出两行错误 | `app/src/kernel/subagent.ts`（`subagentSchema`） | 有枚举时 pi 在执行前就以 `Validation failed for tool "subagent"` 拒绝，§3.3 的原因与 `Correct form` 到不了模型（2026-10-26 审查）。另一种：保留枚举，改由 pi 的校验报错（文字是 pi 的，没有 `Correct form`） | 你回来看时（2026-10-26 你不在，按推荐定；记录在 team-checks.md“要你决定的”第 3 条） |
