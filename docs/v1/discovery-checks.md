# 一键拉取模型 检查记录

依据：[构建规格](../specs/model-discovery.md)（下称“规格”），它实现 [一键拉取模型 Proposal](../proposals/model-discovery.md) 第一版（2026-10-23）。
在 `claude/v1-discovery-91226e` 分支上做（从 `app-v0` 的 54f0758 切出，第一个提交是规格、proposal、状态表与文档），没有推送。

## 状态

（实现与测试进行中，完成后在这里写结果。）

## 负责人的要求（2026-10-23）

| # | 要求 | 怎么做到 |
| --- | --- | --- |
| 1 | 不留任何未完成项：规格 §3–§9 的每条行为、MD-01…MD-13 与 MD-15 在本次全部实现，并在它列出的每一层通过；不留 TODO、“later”、“not implemented”、桩代码，不留跳过、todo 或已知失败的测试 | `node tests/spec-coverage.mjs --spec discovery` 只对 MD-14 带 `--allow-missing-real`；拉取模型的结果文件里跳过或 todo 的测试按失败算；名字以 `MD-15` 开头的检查对本次新增和改动的文件查 TODO / FIXME / not implemented / later 标记 |
| 2 | 只做规格写了的：不加服务种类、设置、选项、兜底、目录查询、按名字猜、缓存或规格与状态表之外的界面；每条新代码路径都能指到规格的某一节 | 代码注释写明对应的规格小节；只读审查的“范围”一路专门找追溯不到规格的代码并删掉；规格有挡住实现的缺口时先问你，不自己定、不推后；状态表标“临时”的照标，不另加 |
| 3 | 只有 MD-14（真实层）可以留着：要用你数据目录里的 key | 后来你在会话里给了 key（2026-10-23：`HoldThatThgt` 目录下的 `mori.env`、`openrouter.env`、`glm.env`，“use them if u need”），所以 MD-14 在这台机器上跑了：`md-real.mjs` 加了按环境变量取 key 的方式（`MD_REAL_DEEPSEEK_KEY`、`MD_REAL_GLM_KEY`、`MD_REAL_OPENROUTER_KEY`），由运行它的进程从这几个文件读出、不打印；key 只在 Mori 自己的表单里输入，由 Mori 加密保存；录下的样本与 fixture 只有响应体和状态，没有请求头；用你数据目录的 `--source` 方式照旧可用 |
| 4 | 方法：用 Workflow 实现 | 先写契约（`shared/models.ts` 的类型与命令 schema、文件归属），再并行实现、每一路后接审查；然后只读审查（找问题 + 对抗核实，含范围一路）；再写测试；最后自己整合、构建、依次跑全部套件 |

## 实现中问你的（2026-10-23）

| # | 问题 | 你的回答 | 现在的做法 |
| --- | --- | --- | --- |
| 1 | 首次启动表单保存（key A）后把 Base URL 改到另一个 origin、框空着再拉取：§6.6 说拉取用内存里的 A，但接着保存时框空不发 key，模型层规格 §4.1 改了 origin 就删已存的 key，结果拉取有 key、保存后没有，占位却仍写“Saved. Leave empty to keep it.” | 选项 2，并修好占位文字（“option 2 + 修复占位数字”，按占位文字理解） | 规格 §6.6 与 first-run.md 已写明：内存里的 key 只在 Base URL 与保存的提供商同一个 origin 时用，占位写“Saved. Leave empty to keep it.”；origin 不同时拉取不带它、占位写“Optional”；带着不同的 origin 保存后内存里的 key 丢掉。MD-11 的“保存后改地址再拉取用内存里的 key”改成只改路径；另有一条检查改到别的 origin 时 key 与占位都回到 Optional |

## 规格更正

| # | 更正 | 依据 |
| --- | --- | --- |
| 1 | 规格更正（规划会话，2026-10-23）：§4.1 `chat` 先看 `capabilities.completion_chat`（布尔），再看 `type` | proposal §7：Mistral 的 `capabilities.completion_chat` 照通用规则读到；Mistral 的行同时有 `type: "base"`（或 `"fine-tuned"`），按原来的顺序 `type` 先下结论为假，每个 Mistral 聊天模型都会标 Not a chat model。规格与 proposal 冲突时以 proposal 为准，所以是规格的错，不是新的决定 |

| 2 | 规格更正（规划会话，2026-10-23）：§4.1 `contextWindow` 里 `meta.max_model_len`、`meta.n_ctx`、`meta.max_total_tokens` 三项（相对顺序不变）放在 `context_length` 之前 | 对照 llama.cpp 源码（`server-models.cpp`）：router 模式每行的 `context_length` 是 `n_ctx_train`（训练窗口），已加载模型的 `meta.n_ctx`（实际在用的窗口）只补进行里没有的键；按原来的顺序会读成训练窗口。`meta.*` 只出现在 llama.cpp 与 GPUStack `with_meta` 的行里，总是实际在用的窗口，proposal §7 |
| 3 | 规格更正（规划会话，2026-10-23）：§4.2 百炼一行，`inference_metadata.request_modality` 原样合并进行、按 §4.1 读，只有文字的模型因此明确报告没有图片；`capabilities`、`features`、`model_info` 不原样合并 | 原来只按对应取正面的值，只有文字的模型的图片为“没报告”；原样合并 `capabilities`（例如 `["TG"]`）会让 §4.1 把 `chat` 读成假、`VU` 也不算图片，所以只合并这一个字段 |
| 4 | 规格更正（规划会话，2026-10-23）：§3.2、§3.3 里对象有 `has_more` 或 `hasMore` 即为 Anthropic 形状，翻页的游标取 `last_id` 或 `lastId`（查询参数仍是 `after_id`） | MD-14 用你的 key 录下的 z.ai 列表（`glm-models-1.json`）是 `{ data, firstId, hasMore, lastId }`：按原来的写法认不出 Anthropic 形状，GLM 的 Add provider 写 “Detected: OpenAI-compatible server”，`hasMore` 为真时也不会翻页。API type 仍只看地址 |

## 已知的限制与没验证的

- llama.cpp router 模式里没加载的模型只有 `context_length`（训练窗口），清单把它当报告的窗口、没有提示；§6.2 的 `trained_window` 提示只写给 Ollama，不另加（规划会话，2026-10-23）。
- 一次加入很多模型时的 `mori.profiles`（审查 C11）：原来每个探针开始、每一步、结束各发一份全部档案，一次加入 468 个模型时后台进程卡住数秒、序列化几百 MB。
  现在同一轮事件循环里的变化合成一份（第一份立即发、其余在这一轮结束时发最新的一份），拼档案视图由每个模型线性查找改为一次建索引；载荷与模型层规格 §9.5 相同。
  剩下的：真实写档案时每个探针在自己的一轮里结束，仍各发一份全部档案（实测 1000 个模型约 1000 份、合计约 1 GB，30 秒内陆续发出、发完即释放，后台进程最长停顿 0.5 秒），
  每个探针结束也重写一次整个 `model-profiles.json`。再合并要按时间节流或成批写，规格没有这样的值，没有做；要做时需要你定一个新的临时默认值。
- 审查 C8 的修法（保存成功晚到时不关掉已经换成的别的表单）同样用在了 Edit provider 和模型表单（Edit）：它们原来有同样的问题，修法只是落实“同一时刻只开一张”。
- SGLang 没有 `/version` 接口（版本在 `/server_info`，按 2026-10-23 的 `http_server.py`）：照 §3.3 与模型层规格 §7.1，SGLang 的版本仍为 null，档案键为 `sglang|unknown`，同这次之前（规划会话，2026-10-23：不改）。

## 实现时定下的（规格没写、实现必须有一个值的地方）

契约里的 D1–D18（`side-session-notes` 的 `discovery-contract.md`，这里照抄要点）：

| # | 情形 | 做法 |
| --- | --- | --- |
| D1 | 列表以外的请求（§3.3 第 6 步、§4.2 详情、读版本）的认证头 | 有 key 时带 `Authorization: Bearer <key>`；列表请求按 §3.2 |
| D2 | 有 Anthropic 提示时的第 ① 个列表地址 | 总带 `anthropic-version: 2023-06-01`；`x-api-key` 与 `Authorization` 只在有 key 时带 |
| D3 | `rejected`、`invalid` 没有原文时的“状态行” | `HTTP <状态码> <状态文字>` |
| D4 | `unreachable` 的 detail | 连接错误的 cause 原文（例如 `connect ECONNREFUSED 127.0.0.1:9`），没有时为错误原文；超时为 `Timed out after 15s` |
| D5 | 列表地址回 3xx、响应体超过 8 MB | 这一个地址按 `invalid` 失败（`Redirected to <location>`、`The model list is larger than 8 MB.`），接着试下一个；最后一个决定 `listError`（404/405 为 `no_list`，其余为 `invalid`）；401/403、连接失败、超时即停 |
| D6 | 15 秒从什么时候算 | 拿到这个 origin 的位置、发出之后，到读完响应体 |
| D7 | §3.3 的“第一行”“每一行” | 第 3 步与第 6 步 Ollama 的条件看第一行；第 4、5 步要求列表不空 |
| D8 | Anthropic 形状的翻页 | `after_id` 取响应的游标（字符串时），否则取最后一行的 id；游标是 `last_id`，没有这个字段时是 `lastId`（上面“规格更正”第 4 条） |
| D9 | 不是对象的行、id 不是字符串 | 当作没有字段的行，id 为空（Can’t add this model: the ID is empty）；先去重（留第一次出现的）再截到 1000 条 |
| D10 | 合并同时进行的读取 | 合并列表请求、翻页与 §3.3 的种类判断（含拿到列表后第 6 步的判断），键为 `baseUrl` + `api` + key 的 ref；新提供商不合并；等它的调用全部取消时才中止，所以取消命令不会取消探针第 0 步；单模型模式拿不到列表时第 6 步的判断同样合并一次；读完就丢 |
| D11 | §4.2 里 GPUStack、LocalAI 的 `<base>` | 拿到列表的那个地址的前缀；GPUStack 在拿到列表的地址上加 `with_meta=true` 重读 |
| D12 | 日志 | `discover <主机> kind=… models=… ms=…` 只对命令记；每个失败的详情请求记一行；日志里没有 key |
| D13 | 编辑提供商时带了 `models` | 不理会（同原来编辑时不理会 `model`） |
| D14 | 百炼的单模型模式 | `<origin>/api/v1/models?model=<编码后的 id>`，不翻页 |
| D15 | MindIE | 每个模型 `<origin>/v2/models/<编码后的 id>/config`，只受每个 origin 的并发上限限制 |
| D16 | `models.addModels` 同一次里重复的 id | 同样的错误文字“<id> is already in <provider name>.” |
| D17 | 操作记录里新提供商的主机 | `new URL(baseUrl).host`（非默认端口带端口）；不是 URL 时只记“Fetch models” |
| D18 | 没报告时的窗口与输出上限 | 放在 `shared/models.ts`（`UNREPORTED_CONTEXT_WINDOW`、`unreportedMaxTokens`），读取器与清单共用一份；defaults.md 的位置一栏已改 |

实现各路报上来、我接受的（A1–A21，`discovery-accepted-decisions.md`）：

| # | 情形 | 做法 |
| --- | --- | --- |
| A1 | 已有提供商拉取用哪个 key（§5.1“同 Test connection”） | 只看内存里有明文的 key（模型池里的那些），其中第一个没有 rate_limited、auth、quota 记录的，都有记录时第一个，都没有明文时不带认证头 |
| A2 | 新的一次发现自己就不合格（地址、key、提供商不存在） | 照样取消正在进行的那次（§5.3“新的到来时取消”） |
| A3 | 新建提供商没带模型 | 错误“A new provider needs at least one model”（界面不会这样发，zod 要求至少一个） |
| A4 | 读版本 | 按 `baseUrl` + `api` 分组，用组里第一个提供商的 key 和地址读一次；种类或版本变化的日志“server of <ref> changed to <kind> <version>; probing again” |
| A5 | 第 9 步与 §5.7 读指标 | 照旧用第一个 key 和探针步的时限（规格只改第 0 步） |
| A6 | key 换成 `***` 的范围 | 放进结果和日志的服务原文（listError.detail、Location、连接错误、日志里的地址）；解析出来的值（id、family、版本）不改，否则短 key 会改坏模型 id；在截到 2000 字之前换 |
| A7 | §4.1 思考、图片、工具 | 按表的列从左到右：任何一处报告支持即为真；“明确报告没有”一列只在没有任何一处报告支持时用；`no_tools` 只在没有一处报告支持工具、且有一处报告没有时加 |
| A8 | Anthropic 形状的后面某一页失败 | 留下已读到的页，记一行日志；读满 5 页仍不到 1000 条时 `truncated` 为假（§5.2 按超过 1000 条定义） |
| A9 | 命令的日志 | 没拿到列表时 `kind=none`；被取消时另记“discover <host> cancelled ms=…”；listError 单独一行 |
| A10 | LocalAI、MindIE 详情的形状（没有录制） | LocalAI 的 `/models/capabilities` 按数组或 `{ data: [...] }`、按 id 对上；MindIE config 读顶层 `max_seq_len`（proposal §14 未验证） |
| A11 | 百炼原生列表“取完” | 某一页少于 100 个，或读满 10 页 |
| A12 | 第 6 步的非 2xx | 不记日志（是判断种类的正常输入）；详情与版本请求失败照样记 |
| A13 | 每个请求的时限 | 用 setTimeout 与 AbortController（AbortSignal.timeout 的计时器不让进程等它）；fetch 与读响应体都和 signal 赛跑 |
| A14 | 连接错误是 AggregateError | 把里面的原文用“; ”连起来 |
| A15 | 关表单时取消拉取 | 只在它的拉取仍是最新一次时发 `models.discoverCancel`，不会取消别处刚开始的拉取 |
| A16 | 拉取命令出错、Fetch cancelled 显示到什么时候（临时） | Add provider 里改 Base URL 或 key 时清掉（连同上次保存失败的原文）；卡上的留到再点这张卡的 Fetch models |
| A17 | 过滤框、Add a model ID 里按 Enter（临时） | 什么也不做，不会按下“Add N models” |
| A18 | 清单的样子（临时） | 表头为 §6.2 的列名，放在最高 440px 的滚动框里；数字框是 inputMode numeric 的文字框；不能加入的行只有勾选框不可用，Added 的行全部不可用；Fetch models 不是主按钮 |
| A19 | “Updated to …”的位置、拉取中的 fetch-status | 在 Detected 一行之后（§6.1 的顺序）；拉取中 fetch-status 没有文字 |
| A20 | 首次启动（临时） | 内存里的 key 是上次保存成功时发出的 key；“有改动”指提供商字段与勾选的模型和上次保存的不同，或 key 框不空；保存中、测试中两个框只读、Fetch models 不可用；回到开始或新的一次拉取时清掉测试结果、探针状态与 Open folder…；有清单时加宽到 720px |
| A21 | 模型行的 Use | 与 Verify、上移下移共用这一行的“保存中”；“(not reported)”的括号部分在一个 span 里 |

## 录制的样本

`app/tests/fixtures/discovery/bodies/`，只存响应体和状态，不存请求头，文件里写明录制日期和地址：

| 文件 | 来源 |
| --- | --- |
| `openrouter-models.json` | 真实录制（2026-10-23，`https://openrouter.ai/api/v1/models`，公开列表，不带 key，468 个模型） |
| `deepseek-models-nokey.json` | 真实录制（2026-10-23，`https://api.deepseek.com/models`，不带 key：401） |
| `glm-models-nokey.json` | 真实录制（2026-10-23，`https://open.bigmodel.cn/api/paas/v4/models`，不带 key：401；不能说明 GLM 有没有列表接口，proposal §14） |
| `deepseek-models.json` | 真实录制（2026-10-23，`https://api.deepseek.com/models`，带你的 key，MD-14 的录制；2 个模型，带 `context_window`、`max_output_tokens`、`input_modalities`、`effort`，与官方文档一致），取代原来的 synthetic 样本 |
| `glm-models-1.json` | 真实录制（2026-10-23，`https://api.z.ai/api/anthropic/v1/models?limit=1000`，带你的 key，MD-14 的录制；11 个模型）：GLM 的 Anthropic 兼容地址**有**列表（proposal §14 原来以为没有） |
| 其余（`README.md` 列出） | synthetic，各自写明依据（核对过的源码或文档地址） |

回放 fixture（`app/tests/fixtures/discovery/ui/`）：`md-openrouter.json`（真实，公开列表）、`md-glm.json`（真实，不带 key 的 401）、`md-deepseek-card.json` 与 `md-glm-card.json`（真实，MD-14 用你的 key 从卡上拉取录下）、`md-deepseek.json` 与 `md-shapes.json`（synthetic：合成端点的 rich、typed、ollama 等形状，覆盖真实服务给不出的清单情形与 §8 的五种提示）。

## 真实端点上看到的（MD-14，2026-10-23）

- DeepSeek：列表读出的窗口 1048576、输出上限 393216、思考、图片（只有 deepseek-flash）都与官方文档一致；勾选加入后探针完成。
- OpenRouter：468 个模型，过滤框按 id 子串过滤；加入一个免费、列出工具的模型。OpenRouter 的免费模型都要求思考，探针第 1–7 步里关闭思考的请求被拒（400 “Reasoning is mandatory”），档案为出错：这是模型层规格 §7.3 的判定（不是一键拉取的范围），可作为模型层的后续。
- GLM（`https://api.z.ai/api/anthropic`）：带 key 时第一个列表地址就拿到 11 个模型；列表里是小写的 `glm-5.3`，按 MD-14 手填的 `GLM-5.3` 照 §6.4 算作另一个 id，服务也认它，探针完成、工具调用已验证。
- z.ai 的 Anthropic 形状列表用驼峰的 `hasMore`、`lastId`（规格写的是 `has_more`、`last_id`），按原来的规格认不出 Anthropic 形状、Detected 写 OpenAI-compatible server；已按上面“规格更正”第 4 条改为两种写法都认。
- 一次完整的 MD-14 运行会花一点额度：首次启动与加入后的 DeepSeek、GLM 探针；录制时 DeepSeek 经本机转发，读版本认作 unknown，会再探测一次。
