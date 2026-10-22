# 临时默认值（v1 模型层）

实现时需要一个值、但还没有经过你确认的地方都登记在这里。每一项都是“临时默认值”，拿到依据后再定。
来源：[构建规格](../specs/model-providers.md) §12；位置是规格 §2 定下的代码落点，时长都集中在 `app/src/kernel/modelTimings.ts`。
v0 的临时默认值仍在 [v0/defaults.md](../v0/defaults.md)，被本规格取代的行在那里注明。

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
| 区域建议 | 回环地址（127/8、`::1`、`localhost`）→ `local`；10/8、172.16/12、192.168/16、169.254/16、`fc00::/7`、`.local` 与不含点的主机名 → `intranet`；其余 → `public` | `app/src/kernel/modelConfig.ts`（首次启动与提供商表单的预选怎么拿到它，见 screens/models-settings.md 待定 8） | 只是预选建议，你确认后才生效；按地址的常见含义划分 | 遇到内网用公网段地址、或公网域名指向内网时 |
| 迁移时 `maxTokens` 缺失 / 不小于窗口 | pi 的默认 16384 / 窗口的一半 | `app/src/kernel/modelMigrate.ts` | 与 pi 自己的默认相同；v1 要求 `maxTokens` 小于窗口，取一半给输入留地方 | 你走查迁移结果时 |
| 新模型表单的 Max output | 16384 与窗口一半中较小的 | `app/src/renderer/src/components/`（模型表单） | 同上一行的理由，与迁移一致 | 拿到内网端点时 |
| 兼容选项的标签与说明 | 六个勾选框，标签写端点的情况，下面一行小字写勾了之后 Mori 怎么发请求，例如“Endpoint needs max_tokens instead of max_completion_tokens” / “Older endpoints don’t recognize max_completion_tokens”；全文见规格 §9.1；提供商卡上只列标签 | `app/src/shared/models.ts` `COMPAT_LABELS`、`COMPAT_HINTS`；`app/src/renderer/src/components/settings/fields.tsx` `CompatChecks`（提供商表单与首次启动表单共用） | v0 方案 5.2 要求每项配说明；沿用 english-ui 的英文（[v0/ui-strings.md](../v0/ui-strings.md)），v1 合并时一度只有规格原来的短标签、没有说明，2026-10-21 改回 | 你走查设置页与首次启动时；拿到内网端点时 |
| pi 里的占位 `apiKey` | `mori-pool` | `app/src/kernel/modelCompile.ts` | pi 要有 key 才把提供商当作已配置（K1）；不保密，真正的 key 由模型池写进认证头，占位不会发到服务端（MP-32） | pi 升级时 |
| 重做说明文字、各提示文字 | 规格 §6.1 的重做说明，§9 的界面文字 | `app/src/kernel/modelContext.ts`（重做说明）；`app/src/renderer/src/components/`（提示、阶段行、说明卡、拒绝启动卡） | 重做说明要让新模型知道前半段被隐藏、工作区可能已改；英文给模型读最稳 | 内网模型对英文说明的理解不好时；你走查时 |
