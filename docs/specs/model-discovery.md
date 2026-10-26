# 一键拉取模型构建规格

状态：构建规格，按 [一键拉取模型 Proposal](../proposals/model-discovery.md) 第一版（2026-10-23）写成，待评审。更新日期：2026-10-23。

本文是 proposal 的实现说明：proposal 讲心智模型，本文讲在 Mori 里怎么做、做到什么算完成。
两者冲突时以 proposal 为准；本文不另加 proposal 没有的行为（§11 的临时默认值除外）。proposal 没定、实现又必须有一个值的地方，
本文给出临时默认值，登记在 [v1/defaults.md](../v1/defaults.md) 的“一键拉取模型”一节（§11）。检查记录、实测结果与未验证项在
[v1/discovery-checks.md](../v1/discovery-checks.md)。

本文扩展 [统一模型提供商构建规格](model-providers.md)（下称“模型层规格”）：配置、编译、选择器、模型池、探针的判定都不变；
本文改到的模型层规格条目在那边注明“（2026-10-23 注：见 model-discovery.md §n）”。在 [app-v0](../app-v0.md) §6“后台进程只做八件事”里属于第 6 件（模型层）。

## 0. 范围

**本规格实现** proposal 的全部内容：

- 读取器：整理地址、认出服务种类、读列表和详情接口、把各家字段统一成 Mori 的模型字段，每个值注明是否服务报告（§3、§4）；
- `models.discover` 与 `models.discoverCancel` 命令：新提供商带临时 key，已有提供商用已保存的 key（§5）；
- 提供商表单改成“地址和 key → Fetch models → 清单 → Add”，卡片上的 Add model 改成 Fetch models，首次启动表单同样（§6）；
- 一次加入多个模型：`models.saveProvider`、`models.firstRun` 收多个模型，新命令 `models.addModels`（§5.4）；
- 探针第 0 步改用读取器，档案记下服务报告的输出上限、思考、图片（§7）；
- 模型行上的“not reported”和“Server reports …”提示与一键采用（§8）；
- 现有测试随之调整（§13.4）。

**已定的**（proposal §12，2026-10-23）：

1. 拉取后先列出清单再加入；不是全部直接加入。
2. 字段只用服务报告的值，没报告的用默认值并标出；不查 pi 自带的模型目录，不按模型名猜。
3. API type 自动识别，认不出才让你选，结果可以改。
4. 服务不报告类型时：只有一个模型就勾上，多个都不勾，提供 Select all（proposal §12 第 4 条）。
5. 加入的模型全部自动跑探针，清单底部写明代价（第 5 条）。
6. 兼容选项这一轮不自动，仍然手勾（第 6 条）。
7. 不加“请求极大 `max_tokens`、读报错”的探针（第 7 条）。
8. Ollama 的窗口依次取 `/api/ps` 的当前窗口、Modelfile 的 `num_ctx`、训练窗口；用训练窗口时行上提醒（第 8 条）。

**不做**：

- 不轮询；只在你点 Fetch models 时拉。后台进程启动、打开会话时只按模型层规格 §7.1 读服务版本（§7.3）。
- 不发对话请求，不经模型池，不按项目区域过滤（同 Test connection，模型层规格 §4.3）。
- 不跨 origin：所有请求都发往你填的地址的 origin（协议、主机、端口）。
- 不改配置的 schema；配置里不记值的来源。
- 不新增依赖。

## 1. 术语与代码名

| proposal 用语 | 本文与代码中 | 说明 |
| --- | --- | --- |
| 发现 | discover | 你点 Fetch models 时做的一次读取（§5） |
| 读取器 | reader，`kernel/discoverRead.ts`（纯函数）与 `kernel/modelDiscover.ts`（发请求） | §3、§4 |
| 服务种类 | `ServerKind` | §3.3 的表；扩展模型层规格 §7.2 的五种 |
| 发现的模型 | `DiscoveredModel` | §5.2 |
| 报告值 | `reported` | 服务报告的值；没报告的字段用默认值 |
| 清单 | checklist，`settings/Checklist.tsx` | §6.2 |
| 列表请求 | list request | 读模型列表的那个 GET（§3.2） |
| 详情请求 | extra request | 按种类再读的接口（§4.2） |

## 2. 组件与代码落点

| 组件 | 文件 | 做什么 |
| --- | --- | --- |
| 读取规则 | `kernel/discoverRead.ts`（新） | 纯函数：整理地址与列表地址（§3.1、§3.2）、认出种类（§3.3）、读一行（§4.1）、按种类合并详情（§4.2）、默认值与截断规则（§4.3）。只依赖 `shared/models.ts` 的类型与 `suggestZone` 之外的常量，单元测试直接喂录下的响应体 |
| 发现 | `kernel/modelDiscover.ts`（新） | 按 `discoverRead` 的计划发 GET（和 Ollama 的 POST `/api/show`），限时、限量、隐去 key、合并同一提供商同时进行的读取、限制每个 origin 的并发（§5.3）；命令的发现同一时刻只有一次、可取消（§5.3）；给命令、探针第 0 步和读版本共用 |
| 接线 | `kernel/modelLayer.ts` | 只加接线，不加读取规则：按 §5.1 给已有提供商取 key（key 的明文只在这里，`secrets`）；探针第 0 步的新依赖（调用 `modelDiscover`，带这个提供商的 key 与 §11 的时限；`getText` 留给第 9 步和模型层规格 §5.7 的读指标（2026-10-26 删：第 9 步与 §5.7 的读指标都删掉了，`getText` 随之去掉，模型层规格 §7.3））；`checkVersions` 改用读版本（§7.3） |
| 命令 | `kernel/modelCommands.ts` | `models.discover`、`models.discoverCancel`、`models.addModels`；`saveProvider`、`firstRun` 收多个模型；`saveModel` 只改不加（§5） |
| 探针第 0 步 | `kernel/probes.ts` | `detectServer`、`judgeServer` 改为调用读取器的单模型模式（§7.1）；`propsWindow`、`versionField`、`getJson` 移到 `discoverRead.ts`、`modelDiscover.ts` |
| 时长 | `kernel/modelTimings.ts` | 发现请求的时限（§11） |
| 档案 | `kernel/modelProfiles.ts` | `auto.meta` 与 `ProfileView.reported`（§7.2）；`ServerKind` 的 zod 枚举 |
| 进程桥 | `shared/models.ts` | `ServerKind`、`SERVER_KIND_LABELS`、`DiscoveredModel`、`DiscoverResult`、新命令与改动的命令 schema（§5） |
| 界面 | `renderer/src/components/settings/ProviderForm.tsx`、`Checklist.tsx`（新）、`ModelRows.tsx`、`Providers.tsx`、`FirstRunForm.tsx`；`state/settings.ts`、`state/actionLog.ts` | §6、§8；screens 见 [models-settings.md](../v1/screens/models-settings.md)、[first-run.md](../v1/screens/first-run.md) |

每个文件不超过 2000 行，每个函数不超过 50 行、不超过 5 个入参（AGENTS.md）；`modelLayer.ts`（1002 行）只加上面那一行的接线，`modelSession.ts`（1626 行）不改。

（2026-10-23 注：审查 C11 的资源修法也落在 `modelLayer.ts` 与 `modelProfiles.ts`，不只是上面的接线。`modelLayer.ts`：探针开始、每一步、结束引起的
`mori.profiles`，一轮事件循环里第一条立即发、之后的合并到轮末（setImmediate）补发一条最新的（`scheduleProfiles`、`endProfilesTurn`）；
拼档案视图时按配置建一次 ref → 目标的索引（`refTargets`、`profileViews`，`mori.profiles` 与 `models.get` 共用）。`modelProfiles.ts`：
`ProfileBook.views(refs, resolve?)` 每次调用给档案建一次索引，`resolve` 由调用方传入上面的索引。载荷同模型层规格 §9.5；
代码注释写的出处是 §9“安全与资源”与负责人的要求“不能无限量地用内存、CPU”；§9 本身只写 key、origin、每个 origin 的并发与不缓存，
这条修法记在这里。为什么改、实测与剩下的代价见
[discovery-checks.md](../v1/discovery-checks.md)“已知的限制与没验证的”。）

## 3. 地址、列表与服务种类

### 3.1 整理地址

`models.discover` 收到新提供商的 `baseUrl` 后：

1. 去掉首尾空白；不是 http 或 https URL 时命令失败，`error` 为“Base URL must be an http or https URL.”（同表单的字段错误）。
2. 去掉 query 和 hash，去掉结尾的 `/`。
3. 路径以下面之一结尾时去掉它（只去一次，按列出的顺序比较）：`/chat/completions`、`/completions`、`/responses`、`/messages`、`/embeddings`、`/models`。
4. **Anthropic 提示**：路径里有一段等于 `anthropic`（不分大小写），或主机是 `api.anthropic.com`。有提示时再去掉结尾的 `/v1`。
5. 结果叫 **base**。

已有提供商（`target.kind = 'provider'`，以及探针第 0 步和读版本）不整理地址：base 就是配置里的 `baseUrl`，Anthropic 提示只看 `api` 是不是 `anthropic-messages`。

### 3.2 列表请求

按顺序试，拿到“模型列表”就停（最多 3 次）：

| 情况 | 依次请求 | 认证头 |
| --- | --- | --- |
| 没有 Anthropic 提示 | ① `<base>/models`；② 只在 base 的路径不以 `/v<数字>` 结尾时：`<base>/v1/models`，成功时建议的 Base URL 为 `<base>/v1` | `Authorization: Bearer <key>` |
| 有 Anthropic 提示 | ① `<base>/v1/models?limit=1000`；② 前缀 + `/models`；③ 前缀 + `/v1/models`。前缀 = base 的路径里 `anthropic` 那一段之前的部分（主机是 `api.anthropic.com` 时没有 ②③） | ①：`x-api-key: <key>`、`Authorization: Bearer <key>`、`anthropic-version: 2023-06-01`；②③：`Authorization: Bearer <key>` |
| 已有提供商 | `openai-*`：只试 `<baseUrl>/models`。`anthropic-messages`：同“有 Anthropic 提示”一行的 ①②③，前缀取 `baseUrl` 路径里 `anthropic` 那一段之前的部分；主机是 `api.anthropic.com` 或路径里没有这一段时只试 ① | 同上 |

没有 key 时不带认证头。

- **模型列表** = 2xx、JSON，并且是数组，或对象的 `data` 是数组。
- 401、403：停止，`listError.kind = 'rejected'`。
- 连接失败、超时（§11）：停止，`listError.kind = 'unreachable'`。
- 404、405、其他 4xx、5xx、不是 JSON、没有数组：试下一个；都不行时，最后一次是 404 或 405 为 `no_list`，否则为 `invalid`。
- Anthropic 形状的列表（对象有 `has_more` 或 `hasMore`）且这个字段为真：带 `after_id=<游标>` 再取，最多 §11 的页数；
  游标为 `last_id` 或 `lastId`，查询参数仍是 `after_id`；两种写法都有时用 `has_more`、`last_id`。
  （规格更正（规划会话，2026-10-23）：z.ai 的 Anthropic 兼容列表用 hasMore、lastId，见录下的 glm-models-1.json）
- 列表超过 §11 的条数时只取前面的，结果里 `truncated: true`；翻页（Anthropic 形状、§4.2 的百炼）凑够这个条数就停。
- 同一个 id 只保留第一次出现的。

**列表地址只用来读**：结果的 `baseUrl` 在没有 Anthropic 提示、② 成功时为 `<base>/v1`，其他情况都是 base（§3.1 整理后的地址，没拿到列表时也给出）；
有 Anthropic 提示时，从前缀读到的列表只用它的 id 和字段，`baseUrl` 仍是 base，`api` 仍是 Anthropic Messages。

### 3.3 服务种类

拿到列表后按下面的顺序判断，第一条成立的就是种类：

| 顺序 | 条件 | 种类 |
| --- | --- | --- |
| 1 | 列表响应头有 `X-New-Api-Version`，或对象有 `success: true` | `newapi` |
| 2 | 主机：`api.deepseek.com` → `deepseek`；`api.moonshot.cn`、`api.moonshot.ai`、`api.kimi.com` → `moonshot`；`dashscope.aliyuncs.com`、`dashscope-intl.aliyuncs.com`、以 `.dashscope.aliyuncs.com` 或 `.maas.aliyuncs.com` 结尾 → `dashscope`；`qianfan.baidubce.com` → `qianfan`；`openrouter.ai` → `openrouter`；`api.anthropic.com` → `anthropic` | 见左 |
| 3 | 第一行的 `owned_by`：`vllm` → `vllm`；`sglang` → `sglang`；`llamacpp` → `llamacpp`；`lmdeploy` → `lmdeploy`；`xinference` → `xinference`；`tensorrt_llm` → `tensorrt`；`MindIE Server` → `mindie`；`gpustack` → `gpustack` | 见左 |
| 4 | 每一行的 `created` 都是 1677610602 | `litellm` |
| 5 | 每一行的 `created` 都是 1626777600，且有 `permission` 字段 | `oneapi` |
| 6 | 以上都不成立：并行 GET `<origin>/.well-known/localai.json`、`<origin>/api/version`、`<origin>/props`、`<origin>/api/v1/models`、`<origin>/info`，按右边的顺序判断 | `localai`：第一个是带 `version` 的 JSON；`ollama`：`/api/version` 有 `version`，且列表行有 `owned_by` 和 `created`；`llamacpp`：`/props` 有 `build_info`；`lmstudio`：`/api/v1/models` 的 `models` 是数组、其中的项有 `key`；`tgi`：`/info` 的 `router` 是 `text-generation-router` |
| 7 | 都不是 | `unknown` |

- 第 6 步的响应都留着给 §4.2 用，不再重复请求。
- **不再只凭 `/version` 认 vLLM**（模型层规格 §7.3 第 0 步原来的规则）：LocalAI、TensorRT-LLM 也回答 `/version`。vLLM 的列表行 `owned_by` 总是 `vllm`。
- **服务版本**沿用模型层规格 §7.1 的读法，不让已有档案的键变：`vllm`、`sglang` GET `<origin>/version` 的 `version`；`ollama` 取 `/api/version`；`llamacpp` 取 `/props` 的 `build_info`；其他种类为 `null`（档案键里写 `unknown`）。
  原来被认成 vLLM 的 LocalAI、TensorRT-LLM：下一次读版本（§7.3）认出种类变了，各重新探测一次，之后版本为 `unknown`（检查记录里写明）。
- **界面显示的名字**（`SERVER_KIND_LABELS`）：vLLM、SGLang、llama.cpp、Ollama、LM Studio、Xinference、GPUStack、MindIE、TGI、LMDeploy、LocalAI、TensorRT-LLM、LiteLLM、New API、One API、DeepSeek、Moonshot AI、Alibaba Cloud Model Studio、Baidu Qianfan、OpenRouter、Anthropic；`unknown` 写“OpenAI-compatible server”，列表是 Anthropic 形状时写“Anthropic-compatible server”。
  Anthropic 形状 = 列表的对象有 `has_more` 或 `hasMore`（§3.2）；它决定翻页（§3.2）、这一行的写法与 §4.1 是否再看 `max_tokens`，
  不改种类（仍按上表）与 API type（只看地址，§3.4）。
  （规格更正（规划会话，2026-10-23）：z.ai 的 Anthropic 兼容列表用 hasMore、lastId，见录下的 glm-models-1.json）

### 3.4 API type、名称、区域

- `api`：你在表单里手动改过 API type（界面把它作为 `target.api` 发来，§6.1）时用你的；否则有 Anthropic 提示为 `anthropic-messages`，没有为 `openai-completions`。OpenAI Responses 只能手选。
  只看地址：列表的形状只影响 Detected 那一行的写法（`anthropicShape`），New API 的 `supported_endpoint_types` 只用来判断是不是聊天模型（§4.1）；
  没有提示时拿到 Anthropic 形状的列表，地址里没有能存下的 Anthropic 地址，所以不改 `api`。
- `name`：base 的主机名，端口不是协议默认端口时加 `:<端口>`（例如 `api.deepseek.com`、`10.0.0.5:8000`）。提供商 id 照模型层规格 §4.1 由它生成。
- 区域：不在结果里；界面照现在的规则用 `shared/models.ts` 的 `suggestZone` 按 Base URL 预选。

## 4. 每个字段怎么读

### 4.1 读一行

对列表的每一行（加上 §4.2 合并进来的字段），按下表从左到右找第一个有效值。“正整数”包括只含数字的字符串；路径用 `.` 分层；数组比较不分大小写。

| 字段 | 服务报告的值（依次） | 明确报告“没有” | 没报告时 |
| --- | --- | --- | --- |
| `contextWindow` | 正整数：`max_model_len`、`context_window`、`meta.max_model_len`、`meta.n_ctx`、`meta.max_total_tokens`、`context_length`、`max_context_length`、`context_size`、`max_input_tokens`、`top_provider.context_length`、`metadata.context_length`（规格更正（规划会话，2026-10-23）：三个 `meta.*` 放在 `context_length` 之前——它们只出现在 llama.cpp 与 GPUStack `with_meta` 的行里，总是实际在用的窗口；llama.cpp router 模式的 `context_length` 是训练窗口，proposal §7） | — | 128000 |
| `maxTokens` | 正整数：`max_output_tokens`、`max_completion_tokens`、`top_provider.max_completion_tokens`；列表是 Anthropic 形状或种类是 `qianfan` 时再看 `max_tokens`。**不小于 `contextWindow` 的值不算报告** | — | 16384 与窗口一半中较小的 |
| `reasoning` | 布尔真：`supports_reasoning`、`capabilities.reasoning`、`capabilities.thinking.supported`；对象存在：`effort`、`reasoning`；数组含 `reasoning` 或 `thinking`：`capabilities`、`features`、`supported_parameters`、`model_ability`、`tags`、`metadata.tags` | 上面的布尔为假；数组 `capabilities`、`model_ability`、`supported_parameters` 存在但不含这两个词 | 不勾 |
| `image` | 数组含 `image`：`input_modalities`、`architecture.input_modalities`、`inference_metadata.request_modality`；布尔真：`supports_image_in`、`supportsImageInput`、`capabilities.vision`、`capabilities.image_input.supported`；数组含 `vision` 或 `vlm`：`capabilities`、`model_ability`、`tags`、`metadata.tags`；`type` 为 `vlm` | 上面的布尔为假；三个 modality 数组存在但不含 `image`；`capabilities`、`model_ability` 数组存在但不含 `vision` | 不勾 |
| `family` | 字符串：`details.family`、`model_family` | — | 空字符串 |
| `chat` | 第一个能下结论的：`capabilities.completion_chat`（布尔；规格更正（规划会话，2026-10-23）：放在 `type` 之前，按 proposal §7 Mistral 的字段照通用规则读到——Mistral 的行同时有 `type: "base"`）；`type`（`chat`、`llm`、`vlm`、`language`、`code` 为真；`model` 不看；其他字符串为假）；`mode`（`chat`、`responses`、`completion` 为真，其他为假）；`model_type`（`LLM` 为真，但 `model_ability` 存在且不含 `chat` 时为假；其他为假）；数组 `capabilities` 含 `completion` 或 `chat` 为真、只含 `embedding` 等别的值为假；`output_modalities` 或 `architecture.output_modalities` 存在但不含 `text` 为假；`supported_endpoint_types` 含 `openai`、`openai-response` 或 `anthropic` 为真、否则为假 | — | `null` |
| 工具提示 `no_tools` | 只记“没有”：布尔假 `capabilities.function_calling`、`supports_function_calling`、`capabilities.trained_for_tool_use`；数组 `capabilities`、`model_ability`、`supported_parameters` 存在但不含 `tools` | — | 没有提示 |

- 种类是 `litellm` 时，布尔假一律按没报告（LiteLLM 把不知道的填成 false）。
- vLLM、SGLang 的 LoRA 行（`parent` 不为 null 且没有窗口）用 `parent` 那一行的窗口。
- `reported` 逐个字段记：`contextWindow`、`maxTokens` 有服务报告的值为真；`reasoning`、`image` 有服务报告的值或明确报告“没有”为真；`family` 有值为真。
- 工具支持只作提示，不进配置，探针照旧判定（模型层规格 §7.3 第 3、4 步）。

### 4.2 按种类合并详情

| 种类 | 详情请求 | 合并 |
| --- | --- | --- |
| `sglang` | GET `<origin>/model_info` | 对 `parent` 为 null 的行：`reasoning_parser` 不为 null → `reasoning` 真，为 null → 明确没有；`has_image_understanding` → `image`；`tool_call_parser` 为 null → `no_tools`；`is_generation` 为假 → `chat` 假 |
| `llamacpp` | 第 6 步已有的 `/props`，没有时 GET `<origin>/props` | 行里没有窗口时取 `default_generation_settings.n_ctx`（大于 0 才算）；`modalities.vision` → `image` |
| `ollama` | GET `<origin>/api/tags`、GET `<origin>/api/ps`；每个模型 POST `<origin>/api/show`（`{ "model": <id> }`，§11 的上限与并发） | 按名字对上：`/api/tags` 或 `/api/show` 的 `capabilities`（`tools`、`thinking`、`vision`、`embedding`、`completion`）与 `details.family`；窗口依次取 `/api/ps` 的 `context_length`、`/api/show` 的 `parameters` 里的 `num_ctx`、`/api/tags` 的 `details.context_length` 或 `/api/show` 的 `model_info["<general.architecture>.context_length"]`；用到最后一种时加提示 `trained_window` |
| `lmstudio` | 第 6 步已有的 `/api/v1/models` | 按 `key` 或 `loaded_instances[].id` 对上：窗口依次取 `loaded_instances[0].config.context_length`、`max_context_length`；`capabilities.vision` → `image`；`capabilities.reasoning` 存在 → `reasoning` 真；`capabilities.trained_for_tool_use` 为假 → `no_tools`；`type` → `chat` |
| `gpustack` | GET `<base>/models?with_meta=true` 代替原来的列表 | 按 §4.1 读 `meta.*` |
| `mindie` | 每个模型 GET `<origin>/v2/models/<id>/config` | `max_seq_len` → 窗口 |
| `tgi` | 第 6 步已有的 `/info` | `max_total_tokens` → 窗口（列表只有一行） |
| `localai` | GET `<base>/models/capabilities` | 按 `id` 对上，`capabilities`、`input_modalities`、`output_modalities`、`context_size` 合并进行再读 |
| `dashscope` | GET `<origin>/api/v1/models?page_no=<n>&page_size=100`，直到取完或 §11 的页数 | 按 `output.models[].model` 对上：`model_info.context_window` → 窗口；`model_info.max_output_tokens` → 输出；`capabilities` 含 `Reasoning` → `reasoning`；`capabilities` 含 `VU` 或 `inference_metadata.request_modality` 含 `Image` → `image`；`features` 存在但不含 `function-calling` → `no_tools`；`capabilities` 含 `TG` → `chat` 真，不含为假；`inference_metadata.request_modality` 原样合并进行，按 §4.1 读（不含 `Image` 时明确报告没有图片）；`capabilities`、`features`、`model_info` 不原样合并，只按这里的对应（规格更正（规划会话，2026-10-23）） |
| 其他 | 无 | 只按 §4.1 |

- 详情请求失败（连接、非 2xx、不是 JSON、超时）时只用列表本身，不算发现失败；记一行日志。
- 合并时详情的值优先于列表行里同名的值。

### 4.3 能不能用、怎么截断

- 模型 id 不符合模型层规格 §4.1（空、含空白）的行照样列出，但不能勾选，`unusable` 写原因。
- `maxTokens` 最后再检查一次：不小于窗口时按“没报告”重新取默认值（你在清单里改了窗口后，界面按同样的规则检查，§6.2）。

## 5. 命令

### 5.1 `models.discover`

| 参数 | 结果 |
| --- | --- |
| `{ target: { kind: 'new', baseUrl: string, api: ApiType \| null, keySecret: string \| null } \| { kind: 'provider', providerId: string } }` | `DiscoverResult`（§5.2） |

- `kind: 'new'`：`keySecret` 去掉首尾空白后按保存 key 时的同一条规则检查（`modelCommands.ts` 的 `headerSafeSecret`：可打印 ASCII、不含空格；不合格时 `error` 为它的原文“API key contains characters that cannot be sent in a header”）；为 null 或空时不带认证头。key 只在这次发现里用，不存、不进模型池、不写日志，结果里不带。
- `kind: 'provider'`：用这个提供商第一个不在 `rate_limited`、`auth`、`quota` 记录里的 key，都在时用第一个，没有 key 时不带认证头（同 Test connection）；key 不回到界面。地址与 `api` 用配置里的，不整理、不识别（§3.1）。提供商不存在时 `error`。
- 不进写入队列（模型层规格的 `layer.edit`），不重新读 `models.get`。
- 任何放进结果的服务原文里出现 key 时换成 `***`。

### 5.2 结果

```ts
interface DiscoverResult {
  error: string | null;            // 命令本身失败（地址或 key 不合格、提供商不存在）
  cancelled: boolean;              // 被 models.discoverCancel 或新的一次发现取消
  server: { kind: ServerKind; version: string | null } | null;  // 没拿到列表时为 null
  api: ApiType;                    // §3.4
  baseUrl: string;                 // 建议的 Base URL（§3.2 ②成功时是 <base>/v1，否则是 base）
  name: string;                    // §3.4
  anthropicShape: boolean;         // 列表是 Anthropic 形状：对象有 has_more 或 hasMore（§3.2；种类为 unknown 时界面写 Anthropic-compatible server）
  listError: { kind: 'rejected' | 'unreachable' | 'no_list' | 'invalid'; detail: string } | null;
  models: DiscoveredModel[];       // 列表顺序
  truncated: boolean;              // 超过 §11 的条数，只取了前面的
  notListed: string[];             // 只对已有提供商：配置里有、列表里没有的模型 id；没拿到列表时为空
}

interface DiscoveredModel {
  id: string;
  contextWindow: number;           // 报告值或默认值
  maxTokens: number;               // 报告值或默认值，总是小于 contextWindow
  reasoning: boolean;
  image: boolean;
  family: string;
  chat: boolean | null;            // 服务报告的类型；不报告为 null
  reported: { contextWindow: boolean; maxTokens: boolean; reasoning: boolean; image: boolean; family: boolean };
  hints: ('no_tools' | 'trained_window')[];
  unusable: string | null;         // 不能加入的原因（§4.3）；能加入为 null
  added: boolean;                  // 只对已有提供商：这个 id 已在配置里
}
```

`listError.detail`：`rejected`、`invalid` 为服务的原文（最多 §11 的长度，没有原文时为状态行）；`unreachable` 为连接错误或“Timed out after 15s”；`no_list` 为空字符串。

### 5.3 同一时刻一次、取消、限时

- 后台进程同时只做一次 `models.discover`：新的到来时取消正在进行的那次，被取消的那次返回 `cancelled: true`。
- `models.discoverCancel`（`{}` → `{ error }`）取消正在进行的那次；没有在进行的时什么也不做。
- 这两条只管 `models.discover` 命令。探针第 0 步（§7.1）和读版本（§7.3）用同一个读取器，但不占这个位置、不被它取消，只随探针自己的 signal 停止。
- **合并同时进行的读取**：同一时刻对同一个提供商（`baseUrl` + `api` + key 的 ref）的列表与种类判断只做一次，后来的调用等同一个结果；读完就丢，不缓存。
  一次加入多个模型时，各模型的第 0 步因此只读一次列表，各自只发自己的详情请求。
- 对同一个 origin 同时进行的读取请求最多 §11 的个数（命令、第 0 步、读版本合计），多出来的排队。
- 每个请求的时限、响应体上限、Ollama `/api/show` 的并发与上限见 §11。超过响应体上限：列表请求按 `invalid`（“The model list is larger than 8 MB.”），详情请求按失败。
- 发现结束时记一行日志：`discover <host> kind=<种类> models=<条数> ms=<用时>`，失败另记 `listError` 的种类与原文（隐去 key）。

### 5.4 加入

| 命令 | 参数 | 结果 |
| --- | --- | --- |
| `models.saveProvider` | `{ id: string \| null, provider, keySecret?: string, models?: ProviderModel[] }`：新建（`id` 为 null）时 `models` 必须有 1 个以上；编辑时不带 `models` | `{ providerId }` |
| `models.firstRun` | `{ providerId: string \| null, provider, models: ProviderModel[] /* 1 个以上 */, keySecret: string \| null }` | `{ providerId }` |
| `models.addModels`（新） | `{ providerId, models: ProviderModel[] /* 1 个以上 */ }` | — |

- 取代模型层规格 §9.5 里 `saveProvider` 的 `model?`、`thinkingLevel?` 和 `firstRun` 的 `model`。清单不设新会话的思考强度：勾了 Supports thinking 的模型，新会话按 pi 设置的 `defaultThinkingLevel`（模型层规格 §11.1），之后可以在 Edit 里设。
  Edit 里没设过强度的模型，Default effort for new sessions 显示 `config.get` 的 `defaultThinkingLevel`（没有时 Medium），只在你改了时写入。
- 一次命令一次编译、一次写入；`models` 的顺序就是加入后在提供商里的顺序（`addModels` 加在已有模型之后）。
- 加入的每个模型都自动跑探针（模型层规格 §7.4，`probeRefs` 为全部加入的模型）。
- `addModels`：任一 id 已在这个提供商里、或同一次里重复时整次拒绝，`error` 为“<id> is already in <provider name>.”；不改配置。
- `firstRun` 的默认范围：只有一个模型时为 `<provider>/<model>`（同现在）；多个时为提供商 id。同一张表单再次保存时整体替换这个提供商和它的全部模型（模型层规格 MP-33 的规则不变：配置里仍只有一个提供商）。
- `models.saveModel` 去掉 `adding`，只改已有的模型：`{ providerId, model, thinkingLevel? }`，模型不存在时 `error`。模型表单的 Edit 和 §8 的 Use 用它；
  加模型只有 `saveProvider`、`firstRun`、`addModels`。原来 `adding: true` 的分支、`ModelEditor` 的新建模式和操作记录“Add model <provider>/<id>”一起删掉。

### 5.5 操作记录

`state/actionLog.ts`（F8 的“Recent activity”）：`models.discover` 记“Fetch models <主机>”（新提供商）或“Fetch models <providerId>”；`models.discoverCancel` 记“Cancel fetch models”；`models.addModels` 记“Add models <providerId> · <条数>”。从不包含 `keySecret`。

## 6. 界面

状态表在 [models-settings.md](../v1/screens/models-settings.md) 与 [first-run.md](../v1/screens/first-run.md)；这里定主要行为。界面文字为英文，写法按 [v0/ui-strings.md](../v0/ui-strings.md)。
Claude 桌面版没有添加模型的界面，这里的交互没有可照的对应。

### 6.1 提供商表单（Add provider）

- **开始**：只有 Base URL、API key（密码框，可空）、“Fetch models”、“Cancel”（关闭表单）。Base URL 不是 http/https URL 时 Fetch models 不可用。
- **拉取中**：按钮“Fetching models…”不可用，旁边“Cancel”（`models.discoverCancel`）；Base URL、API key 只读；关闭表单的 Cancel 照样可用。
  关闭表单（Cancel、打开别的表单、离开设置页）时先发 `models.discoverCancel`。取消后回到开始，显示“Fetch cancelled”。
- **拉取后**（不论有没有拿到列表），从上到下：
  1. Base URL、API key，以及“Fetch models”（再拉一次：清单和手填的行从头来，见下）；
  2. 一行“Detected: <种类名> <版本>”（版本为 null 时不写；没拿到列表时不显示）；
  3. 结果的 `baseUrl` 与你填的不同（两边去掉首尾空白和结尾的 `/` 后比较）时，Base URL 框换成它；拿到了列表时下面一行“Updated to <url> so the model list loads.”，有列表错误时不写这一行；
  4. Name（预填 `name`）、API type（预填 `api`）、Network zone（按 `suggestZone` 预选，规则同现在）；
  5. 清单（§6.2）或列表错误（§6.3）；
  6. “Add a model ID”一行（§6.4）；
  7. “More settings”，点开后是 Concurrency per key（默认 4）和兼容选项（只在 API type 为 OpenAI-compatible 时）；（2026-10-26 注，负责人走查 M1“fetch models didn’t auto fill compatibility options”：仍按 §0 第 6 条不自动勾；兼容选项上面加一行说明“Mori already adjusts requests for well-known services such as DeepSeek. Check an option only if this server rejects requests.”，“strict mode for tool parameters”一项删掉，见模型层规格 §9.1 的 2026-10-26 注）
  8. 底部“Each model is verified with up to 13 short requests.”、“Add 1 model” / “Add N models”（N 为勾选数，0 时为“Add models”且不可用）、“Cancel”。
- **再拉一次、改地址或 key**：拉取后改了 Base URL 或 API key，清单、列表错误、手填的行都清掉，回到开始（下面的字段一起收起）；点 Fetch models 再拉一次时同样从头来。
  Name、API type、Network zone、More settings 里你改过的值留着，下次拉取后不覆盖；没改过的按新结果重新预填。API type 改过时把它作为 `target.api` 发出（§3.4）。改 API type 不清掉清单。
- **Add**：`models.saveProvider`（`id: null`，`provider` 为表单的值，`models` 为勾选的行，按清单顺序，包括被过滤框藏起来的，`keySecret` 为 API key 框的值（空时不带））。保存中按钮“Adding…”不可用；成功时表单关闭，新卡在最后，模型行显示 Verifying…；失败时表单里原文，本次新存的 key 已删除（同现在）。
- 编辑提供商（Edit）不变：没有 Fetch models、没有清单。

### 6.2 清单

- 标题“Models (N)”，N 为列表条数；右边“Select all”“Clear selection”，只作用于显示着的、能勾的行。列表超过 §11 的条数时标题下一行“Showing the first 1,000 models.”。
  行数（含手填的行）超过 §11 的值时标题下有一个过滤框（占位“Filter models”），按 id 子串过滤显示，不分大小写，不改勾选。
- 列表是空的（`models` 为空、没有 `listError`）：标题“Models (0)”，下面一句“The server didn’t list any models.”，再下面是 Add a model ID。
- 每行：勾选框（读屏名“Add <id>”）、Model ID、Context window、Max output（数字框，千分位不写）、Supports thinking、Image input（勾选框）。没报告的 Context window、Max output 旁写“Not reported”。（2026-10-26 改，负责人走查 M6：改为“Default”，只在服务没报告、且框里的值仍是 Mori 的默认值（窗口 128000；输出上限 16384 与这一行窗口一半中较小的，§11）时写，悬停说明“The server didn’t report this, so Mori used a default. Change it if you know the real value.”。）
- 行上的标记与提示（每个一行小字）：
  - `chat` 为假：“Not a chat model”；
  - `added` 为真：“Added”，不能勾、不能改；
  - `unusable`：“Can’t add this model: <原因>”，不能勾；原因“the ID contains spaces”或“the ID is empty”；
  - `no_tools`：“The server doesn’t list tool support for this model.”；
  - `trained_window`：“Trained context window. Ollama may use a smaller one; run the long-input test after adding.”。（2026-10-26 改：后半句删掉，写“Trained context window. Ollama may use a smaller one.”：长输入测试的按钮删掉了，模型层规格 §7.4 的 2026-10-26 注。）
- **默认勾选**：`chat` 为真的勾上；`chat` 为假的不勾；`chat` 为 null 时，列表里能加入的行只有一行就勾上，否则都不勾。`added`、`unusable` 的不勾。
- 改值按模型表单的检查（“Context window must be a whole number above 0.”等，模型层的同一组文字）；你没改过 Max output 时它随窗口按 §4.3 变。勾选的行有错误时 Add 不可用。
- “Not reported”只说明服务有没有报告这一项，你改了值也留着（同 proposal §9 对模型行的说法）；Max output 因 §4.3 退回默认值时也写。
  （2026-10-26 改，负责人走查 M6“"(not reported)" — what does it mean?”：标记只说明“这个数是 Mori 猜的”，改成“Default”，你把值改成别的就不写、改回默认值又写；Max output 因 §4.3 退回默认值时照样写。这推翻了 proposal 第 176 行“默认值或你改过的值都标”的说法。）
- Model ID 不能改（就是服务的 id）。Family 不显示，按 `family` 原样保存，之后在 Edit 里改。

### 6.3 列表错误

清单的位置换成一句（加上 detail）：

| `listError.kind` | 文字 |
| --- | --- |
| `rejected` | “The server rejected the API key: <detail>” |
| `unreachable` | “Couldn’t reach <主机>: <detail>” |
| `no_list` | “This server doesn’t list its models.” |
| `invalid` | “Couldn’t read the model list: <detail>” |

后面一句“You can still add model IDs below.”。Name、API type、Network zone 照样预填，可以手填模型后 Add。
Add a model ID 加进来的行列在这句下面，样子同清单的行；没有“Models (N)”标题、Select all、Clear selection 和过滤框。

### 6.4 Add a model ID

- 一行：Model ID 输入框和“Add to list”。id 按模型层规格 §4.1 检查，与清单里的行、已有提供商里的模型重复时“Model IDs must be unique within a provider.”。
- 加进清单末尾，勾上，标“Entered by you”；Context window、Max output 取默认值并标“Not reported”，Supports thinking、Image input 不勾，可以改。可以加多个。（2026-10-26 改：标“Default”，规则同 §6.2。）

### 6.5 卡片上的 Fetch models

- 提供商卡上的“Add model”换成“Fetch models”（`models.discover`，`kind: 'provider'`），在卡里打开同样的清单（§6.2），拉取中同 §6.1（没有 Base URL、API key 两个框）。
  清单打开期间卡上的 Fetch models 不可用；关掉清单（底部 Cancel）再点就是再拉一次。卡里不显示 Detected 一行。
- 已加入的行标“Added”；`notListed` 不为空时清单下面一行“Not listed by the server: <id>, <id>”（不删除）。
- 有列表错误时同 §6.3。“Add a model ID”同 §6.4。底部同 §6.1 第 8 项，按钮发 `models.addModels`；成功时清单关闭，新模型加在行的末尾、显示 Verifying…。
- 模型层规格 §9.1 的模型表单只剩 Edit（“Edit model · <provider name>”），不再有新建。

### 6.6 首次启动表单

- 标题“Connect a model”，说明“Enter the base URL and API key, then fetch the models.”。
- 开始、拉取中、拉取后、再拉一次同 §6.1 第 1–7 项与规则，但：没有关闭表单的 Cancel（拉取中的 Cancel 照样有）；“More settings”里只有兼容选项（首次启动没有 Concurrency per key，同现在），
  API type 不是 OpenAI-compatible 时不显示 More settings；区域选 Public 时的说明不变。
- 底部一句“Each model is verified with up to 13 short requests.”（同 §6.1 第 8 项），下面是按钮“Test connection”：勾选数为 0 时不可用。
  表单有改动时先保存（`models.firstRun`，`models` 为勾选的行），再对**第一个勾选的模型**跑 `connection.test`。结果文字、Open folder…、探针状态都同现在，探针状态说的是这个模型。
  （2026-10-26 改，负责人走查 M2：测试成功就关掉表单、进入主窗口，结果文字在主窗口的 Open a folder 提示里显示一次；表单下方不再有 Open folder… 与探针状态，探针进度在打开文件夹后会话的拒绝启动卡上；测试失败、已取消、保存失败时同现在。见 docs/v1/screens/first-run.md“测试成功之后：主窗口”。）
- 再次保存同一张表单：带上次的 `providerId` 整体替换（§5.4）。
- 保存后 API key 框清空、占位“Saved. Leave empty to keep it.”（同现在）。表单把这张表单里最后填过的 key 留在内存里：之后再拉取而框是空的时，用它作为 `keySecret`；
  它不显示、框空时保存不再发送（照旧保留已存的 key），表单关闭就丢掉。
  （2026-10-23 负责人决定：内存里的 key 只在 Base URL 框的地址与上次保存的提供商是同一个 origin（协议、主机、端口）时使用，
  这时占位写“Saved. Leave empty to keep it.”；origin 不同时拉取不带它、占位写“Optional”，因为这时保存会按模型层规格 §4.1
  删除已存的 key；带着不同的 origin 保存之后内存里的 key 丢掉。这样拉取与保存用的 key 一致，已存的 key 也不会发往别的 origin。）

## 7. 探针第 0 步

### 7.1 单模型模式

探针第 0 步（模型层规格 §7.3）改为调用读取器的单模型模式：

- 列表请求只按 §3.2 的“已有提供商”一行；种类按 §3.3；详情只对这个模型（Ollama 只 POST 这一个模型的 `/api/show`；MindIE 只读这一个；百炼用 `?model=<id>` 查询，不翻页）。
  同一个提供商同时进行的第 0 步合并列表与种类判断（§5.3）。
- key 用 §5.1 对已有提供商的选法（原来是第一个 key）。
- 得出 `server: { kind, version }`、`reported`（窗口）和 `meta`（§7.2）。
- 每个请求的时限用 §11 的发现时限（原来是 120 秒的探针步时限）。
- 第 0 步仍不计入短请求；拿不到列表时 `server.kind` 照 §3.3 第 6 步能判断的判断，判断不了为 `unknown`，`reported` 与 `meta` 的各项为 null。

### 7.2 档案

- `StoredProfile.auto` 加可选字段 `meta: { maxTokens: number | null; reasoning: boolean | null; image: boolean | null }`：第 0 步按 §4.1 读到的报告值，没报告为 null（`reasoning`、`image` 明确报告“没有”时为 false）。没有这个字段的旧档案照样读，不重新探测，`PROBE_SUITE` 不变。
- `server.kind` 的 zod 枚举换成 §3.3 的全部种类；旧值都在其中。
- `ProfileView` 加 `reported: { contextWindow: number | null; maxTokens: number | null; reasoning: boolean | null; image: boolean | null } | null`：`contextWindow` 同 `context.reported`；档案没有 `meta` 时整个为 null。
- **训练窗口不记作报告**：Ollama 的窗口只有来自 `/api/ps` 或 Modelfile 的 `num_ctx` 时才写进 `reported`（`context.reported`）；只读到训练窗口时为 null，
  模型行因此写 not reported，也不出“Server reports a context window of …”去把窗口改回训练窗口（proposal §12 第 8 条：训练窗口不是 Ollama 实际用的窗口）。清单里训练窗口照 §4.2 算报告值并带 `trained_window` 提示。
- 有效窗口的算法不变（模型层规格 §7.2）。Ollama 有了报告的窗口后，它的有效窗口可能变小。
- 取消探针（第 9 步）的种类判断不变：只对 `vllm`、`sglang`、`llamacpp`；改认为 `localai`、`tensorrt` 的不再显示 Cancel test…。（2026-10-26 注：Cancel test… 已从模型行删掉，第 9 步由 WP-04 删除，模型层规格 §7.4 的 2026-10-26 注。）（2026-10-26 删：第 9 步已删掉（负责人走查 M7，模型层规格 §7.3），这一条不再有对象。）

### 7.3 读版本

模型层规格 §7.1 的“读服务版本”（后台进程启动时、会话新建或打开时）：

- 每个提供商（`baseUrl` + `api`）读一次，结果用来对比它下面每个模型的档案；不是每个模型读一次。
- 按 §3.2“已有提供商”一行发列表请求，按 §3.3 全部判断种类（第 6 步只在 1–5 步判断不了时发，第 6 步拿到的 `/api/version`、`/props` 就当版本请求，不再发），再发这个种类还没发过的版本请求；
  不发 §4.2 表里的详情请求，不改 `reported`、`meta`。
- 结果 `{ listed, kind, version, versionRead }`：拿到列表时 `listed` 为真；这个种类有版本请求并且读到了版本时 `versionRead` 为真。
  `listed` 为真且种类与档案里的不同时，这个模型重新探测；种类相同时，只有 `versionRead` 为真、读到的版本与档案里的不同才重新探测。
  版本请求失败（连接、非 2xx、没有版本字段）时只比种类，不比版本；拿不到列表时档案不变（同现在，模型层规格 §7.1、MP-12）。
  第 6 步的请求连接失败或超时、种类因此判断为 unknown 时，按拿不到列表处理（档案不变；HTTP 回答（404 等）照样是判断种类的依据；只对读版本，探针第 0 步（§7.1）判断不了仍记 unknown。规格更正（规划会话，2026-10-23，审查 C12）：proposal §10 第 5 条“读失败不算变化”、模型层规格 MP-12）。
  种类本来就没有版本请求的（版本为 null），只在种类变了时重新探测。`modelProfiles.ts` 的 `versionChanged` 照此改。

## 8. 模型行的提示

设置 → Models 的模型行（模型层规格 §9.1）按档案加两种显示。档案的 `reported` 为 null（旧档案）时只有下表第四行可能显示：

- **没报告**：`reported.contextWindow` 为 null 时窗口写“Context window: 128,000 (not reported)”；`reported.maxTokens` 为 null 时同样写在 Max output 后面。
  （2026-10-26 改，负责人走查 M6：改为“ (default)”，只在没报告、而且配置的值仍等于 Mori 的默认值时写（窗口 128000；Max output 16384 与配置窗口一半中较小的，§11），例如“Context window: 128,000 (default)”；悬停说明“The server didn’t report this, so Mori used a default. Use Edit to set the real value.”。用 Edit 改成别的值就不再标；Ollama 只有训练窗口的模型窗口是训练窗口、不是默认值，不标。）
- **不一致**：每条一行小字和“Use”。Use 立即保存（`models.saveModel`，不带 `thinkingLevel`），失败时原文；保存后指纹变化，按模型层规格 §7.4 重新探测。

| 条件 | 文字 | Use 改什么 |
| --- | --- | --- |
| `reported.contextWindow` 不为 null 且不等于配置的窗口 | “Server reports a context window of <N>.” | 窗口改为 N；原来的 Max output 不小于 N 时改为 16384 与 N 一半中较小的 |
| `reported.maxTokens` 不为 null、不等于配置的值、小于配置的窗口 | “Server reports max output of <N>.” | Max output 改为 N |
| `reported.reasoning` 为真、配置没勾 Supports thinking | “The server says this model supports thinking.” | 勾上 Supports thinking |
| 接口为 `openai-completions`、档案的推理字段不是 `none`、配置没勾 Supports thinking、`reported.reasoning` 不为真 | “This model returned thinking content.” | 勾上 Supports thinking |
| `reported.image` 为真、配置没勾 Image input | “The server says this model accepts images.” | 勾上 Image input |

第四行只看档案的推理字段（`reported` 为 null 时把“`reported.reasoning` 不为真”当作成立）。数字按千分位写（同模型行）。

## 9. 安全与资源

- key：新提供商的 key 只经进程通道交给后台进程，只在这次发现的内存里；不写文件、不写日志、不进 F8、不回界面（同模型层规格 MP-26）。服务原文里的 key 换成 `***`。
- 只发往你填的地址的 origin；不跟随跨 origin 的重定向（`redirect: 'manual'`，3xx 按 `invalid`，detail 为“Redirected to <location>”）。
- 不经模型池，不占槽位；对每个 origin 自己限并发（§5.3、§11）。
- 不缓存：命令的结果只在界面的表单状态里，表单关闭就丢掉；后台进程只在读取进行中合并同一个提供商的读取（§5.3），读完就丢。

## 10. 不改的

- 配置 schema（模型层规格 §4.1）；模型 id 建好后不能改；`maxTokens` 必须小于窗口。
- 选择器、模型池、编译、探针第 1–9 步的判定。
- Edit provider、Keys、Groups、Defaults、Project access。
- 区域规则：发现与测试连接一样不按项目区域过滤；区域仍由你确认。

## 11. 临时默认值

登记在 [v1/defaults.md](../v1/defaults.md) 的“一键拉取模型”一节；时长放在 `kernel/modelTimings.ts`。

| 项 | 值 |
| --- | --- |
| 每个发现请求的时限（连接到读完响应体） | 15 秒 |
| 每个响应体最多读 | 8 MB |
| 服务原文最多保留 | 2000 字 |
| 列表最多条数 | 1000 |
| Anthropic 形状列表最多页数 | 5（每页 1000） |
| 百炼原生列表每页 / 最多页数 | 100 / 10 |
| 对同一个 origin 同时进行的读取请求 | 4（命令、探针第 0 步、读版本合计；Ollama 的 `/api/show` 也在其中） |
| Ollama `/api/show` 最多读的模型数 | 100（超过的模型不读 `/api/show`，窗口按 `/api/ps`、`/api/tags` 能读到的） |
| 列表地址最多试 | 3 次（§3.2） |
| 清单显示过滤框的行数 | 超过 20 行 |
| `anthropic-version` 请求头 | `2023-06-01` |
| 没报告时的窗口 / 输出上限 | 128000 / 16384 与窗口一半中较小的（同模型层规格 §12） |
| 名称 | 主机名，非默认端口时加 `:<端口>` |
| 探针代价的说明 | “Each model is verified with up to 13 short requests.”（自动探针第 1–7 步最多 13 个请求） |

## 12. 要改的文件

| 文件 | 改什么 |
| --- | --- |
| `docs/proposals/model-discovery.md` | 状态改为第一版已定；§13 的五条移入 §12 第 4–8 条，§13 只留一句指向（§14、§15 编号不变） |
| `docs/specs/model-discovery.md` | 本文 |
| `docs/specs/model-providers.md` | §0、§2、§7.1–§7.3、§9.1、§9.4、§9.5、§12、§14.4 加“（2026-10-23 注：见 model-discovery.md §n）” |
| `docs/v1/screens/models-settings.md`、`first-run.md`、`README.md` | 提供商表单、清单、卡片的 Fetch models、模型行提示、首次启动的状态表与标识 |
| `docs/v1/defaults.md` | 新一节“一键拉取模型”（§11） |
| `docs/v0/ui-strings.md` | “首次启动”“设置”两节的新文字 |
| `docs/app-v0.md` | §6 第 6 件事加上本文 |
| `AGENTS.md` | 仓库结构与常用命令加上本文和 `test:discovery`；第 4 条第 6 件指向本文；工程约束：试出能用的列表地址（补 `/v1`、去掉 `anthropic` 段）不算 fallback |
| `app/src/kernel/` | §2 表中的文件 |
| `app/src/shared/models.ts` | §5 |
| `app/src/renderer/` | §6、§8 |
| `app/tests/` | §13 |
| `app/package.json` | 脚本 `test:md-unit`、`test:discovery` |

## 13. 验收

### 13.1 测试分层

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 单元 | `tests/unit/discovery/*.test.mjs`（`node --test`，`tests/unit/md-reporter.mjs`），经 esbuild 打包内核模块 | `discoverRead.ts` 的全部规则；`modelDiscover.ts` 用替身 fetch 检查请求顺序、认证头、限时、限量、取消、隐去 key；档案的读写 |
| 合成端点 | `tests/fake-endpoint/server.mjs`（synthetic） | 见下面的“合成端点的行为” |
| App | `tests/ui/md-app-*.mjs` | Electron + 合成端点 |
| 回放 | `tests/ui/md-replay.mjs`，`tests/fixtures/discovery/ui/*.json` | 从真实发现录制：DeepSeek、OpenRouter 的清单与 GLM 的列表错误（或清单）；DeepSeek 加入后（清单里把一个模型的 Context window 改小）设置页的 `models.get` 与 `mori.profiles`（含 `reported`），给模型行提示用 |
| 真实 | `tests/ui/md-real.mjs` | 你的数据目录里的 DeepSeek、GLM，加 OpenRouter |

**响应体样本**（`tests/fixtures/discovery/bodies/`）：

- 真实录制：DeepSeek `/models`、OpenRouter `/api/v1/models`、GLM 的列表请求（成功时的列表，或失败时的状态与原文）。录制脚本只存响应体和状态，不存请求头；文件里写明录制日期和地址。
- 其余种类没有可用的真实部署时手写，文件里写 `"synthetic": true` 和依据（调研时核对过的源码或文档地址，见 proposal §7 与检查记录）：vLLM（含 LoRA 行）、SGLang（含 `/model_info`）、llama.cpp（单模型与 router 模式、`/props`）、Ollama（`/v1/models`、`/api/tags` 有无 `capabilities`、`/api/ps`、`/api/show`）、LM Studio、Xinference、GPUStack（`with_meta`）、MindIE、TGI、LMDeploy、LocalAI、TensorRT-LLM、LiteLLM、New API、One API、Kimi、百炼原生、千帆、Anthropic、DeepInfra（输出上限等于窗口）、Together（顶层数组）、Mistral。
  拿到内网部署后改成真实录制，在检查记录里注明。

**合成端点的行为**（加在文件开头注释里）：

- **默认形状 `vllm` 只改一处**：列表行的 `owned_by` 从现在的 `"fake"`（`server.mjs` 的 `/models`）改成 `"vllm"`；`max_model_len` 与 `/version`（`FAKE_SERVER_VERSION`）照旧。
  按 §3.3 不再只凭 `/version` 认 vLLM，不改的话默认端点会变成 `unknown`；改了之后种类、版本、档案键（`vllm|0.10.1`）都和现在一样，现有的取消探针与版本检查照旧（2026-10-26 注：取消探针已删掉，模型层规格 §7.3）。
- `FAKE_LIST_SHAPE` 的其他取值：
  - `sglang`：`owned_by: "sglang"`，加 `/model_info`；
  - `ollama`：`/v1/models` 的行带 `owned_by: "library"` 和 `created`；`/api/version`、`/api/tags`、`/api/ps`、POST `/api/show`。`FAKE_MODELS` 的第一个模型在 `/api/ps` 里（`context_length` 8192），`capabilities` 含 `tools`；
    第二个在 `/api/show` 的 `parameters` 里有 `num_ctx 16384`，没有 `tools`（得 `no_tools`）；其余只有训练窗口（得 `trained_window`）；
  - `llamacpp`：`owned_by: "llamacpp"`、`meta.n_ctx`、`/props`；
  - `localai`：列表行只有 `id`、`object`，`/.well-known/localai.json`、`/models/capabilities`，也回答 `/version`；
  - `tensorrt`：`owned_by: "tensorrt_llm"`，也回答 `/version`（测只凭 `/version` 不再认成 vLLM）；
  - `litellm`：每行 `created` 1677610602、`owned_by: "openai"`，带 `mode`、`max_input_tokens`、`max_output_tokens`（其中一行输出等于窗口）；
  - `newapi`：响应头 `X-New-Api-Version`、`success: true`、`supported_endpoint_types`；
  - `anthropic`：`/v1/models` 为 Anthropic 形状，要求 `anthropic-version` 头；
  - `rich`：DeepSeek 式字段（`context_window`、`max_output_tokens`、`input_modalities`、`effort`）；
  - `typed`：带 `type`，含一个 `embedding` 行；
  - `nolist`：`/models` 与 `/v1/models` 都 404。
- `FAKE_NO_V1_ROOT=1`：只在 `/v1/models` 回答列表，`/models` 为 404（测补 `/v1`）。
- `FAKE_MODELS` 照旧决定列表里的 id；`FAKE_LIST_DELAY_MS` 让列表请求等这么久再回（测取消与时限）。
- 模型 id 后缀 `-alwaysthink`：不论请求带不带思考参数都先回一段 `reasoning_content`（像总在思考的模型），给 §8 的“This model returned thinking content.”。
- 列表请求和详情请求也各打一行 JSON：`{ "port", "path", "key"（key 末 4 位，没有为 null） }`（测已有提供商用的 key、读版本不发详情请求）。
- 现有探针与对话行为不变；列表请求同样受 `FAKE_KEYS`、`FAKE_REQUIRE_KEY` 约束（401 测 `rejected`）。
- 超过 8 MB 的响应体、跨 origin 的重定向、服务原文里带 key 只在单元层用替身 fetch 测（MD-06），合成端点不做。

### 13.2 验收条目

每条测试的名字以条目编号开头。

| 编号 | 条目 | 通过条件 | 层 |
| --- | --- | --- | --- |
| MD-01 | 整理地址与列表地址 | §3.1 的每一步（空白、query、结尾 `/`、各个端点后缀、Anthropic 提示与去掉 `/v1`）；§3.2 每种情况的请求顺序与认证头、最多 3 次、401/403 与连接失败即停、其余试下一个、`no_list` 与 `invalid` 的区分；补 `/v1` 时给出建议的 Base URL；Anthropic 前缀的列表不改 `baseUrl` 与 `api`；已存的 `…/anthropic` 提供商同样从前缀拿到列表；Anthropic 形状的翻页与凑够条数即停；去重；超过条数时 `truncated`；所有请求同一个 origin | 单元 |
| MD-02 | 服务种类 | §3.3 每一条按顺序判断，各用一份响应体样本；LocalAI、TensorRT-LLM 不再是 vLLM；第 6 步的响应不重复请求；版本按 §3.3 读，已有种类的档案键不变；默认合成端点（`owned_by` 改成 `vllm` 后）认作 `vllm`、档案键不变 | 单元 |
| MD-03 | 读一行 | §4.1 每个字段的每条路径、正整数字符串、明确报告“没有”、不小于窗口的输出上限不算报告（DeepInfra、LiteLLM 样本）、LiteLLM 的假、LoRA 行用 `parent` 的窗口、`chat` 的每种判断、`no_tools` 只记“没有”、`reported` 的逐字段取值；DeepSeek 与 OpenRouter 的真实样本读出的窗口、输出上限、思考、图片与样本一致 | 单元 |
| MD-04 | 按种类合并 | §4.2 每一行：SGLang 的解析器与图片、llama.cpp 的 `n_ctx` 与 router 模式、Ollama 的窗口顺序与 `trained_window`、`/api/tags` 没有 `capabilities` 时用 `/api/show`、LM Studio、GPUStack 的 `with_meta`、MindIE、TGI、LocalAI、百炼翻页；详情失败时只用列表 | 单元 |
| MD-05 | API type、名称 | 你改过的 API type（`target.api`）不被改；Anthropic 提示 → Anthropic Messages；否则 OpenAI-compatible，Anthropic 形状的列表与 New API 的 `supported_endpoint_types` 都不改 `api`；名称为主机名加非默认端口 | 单元 |
| MD-06 | 发现命令 | 单元：服务原文里的 key 换成 `***`；响应体超过 8 MB 为 `invalid`；跨 origin 重定向为 `invalid`；新的发现取消旧的、`discoverCancel` 后 `cancelled: true`；探针第 0 步、读版本不被它们取消；同一提供商同时进行的读取合并；每个 origin 的并发上限。App：新提供商的 key 只用于这次请求，配置、档案、日志、F8 报告里都没有（Fetch 后按 F8 保存报告检查）；已有提供商用 §5.1 选的 key（合成端点日志），key 不回到界面；每个请求 15 秒时限（`FAKE_LIST_DELAY_MS`）；不按项目区域过滤 | 单元、App |
| MD-07 | 清单 | 默认勾选的三种情况（`typed` 的 `embedding` 行不勾、只有一个模型时勾上、多个类型不明时都不勾）；Select all 与 Clear selection 只作用于显示着的、能勾的行；Not reported（改值后仍在；2026-10-26 改为 Default：只在值仍是默认值时，改了就不写、改回又写，§6.2）、Not a chat model、Can’t add this model、两种提示的显示；空列表的一句；改窗口时 Max output 随之变、错误时 Add 不可用；超过 20 行时有过滤框（不分大小写，被藏起来的勾选行照样加入）；Add 的按钮文字随勾选数变 | App、回放 |
| MD-08 | 手填一行 | 拿到列表和列表错误（`nolist`、401）时都能手填加入，列表错误时手填的行列在错误下面；id 检查与重复；Entered by you 与 Not reported（2026-10-26 改为 Default，§6.4） | App |
| MD-09 | 加入新提供商 | 开始只有 Base URL、API key、Fetch models；拉取中两个框只读，关闭表单会取消拉取；拉取后 Name、API type、Network zone 预填且可改；`FAKE_NO_V1_ROOT=1` 时 Base URL 换成 `/v1` 并显示说明，`nolist` 时只换框不写说明；拉取后改 Base URL 或 key 清掉清单，再拉一次时你改过的 Name、API type、区域不被覆盖、改过的 API type 作为 `target.api` 发出；Add 一次写入全部勾选的模型（一次编译，顺序同清单），全部开始探针；保存失败时本次新存的 key 被删除；More settings 里的并发与兼容选项保存进配置；Fetch cancelled | App |
| MD-10 | 已有提供商拉取 | 卡上的 Fetch models 用已保存的 key（合成端点日志里 key 末 4 位对得上）；清单打开时卡上的按钮不可用、不显示 Detected；已加入的行标 Added、不能勾；`notListed` 一行；`models.addModels` 加在末尾并开始探针；重复 id 整次拒绝、配置不变；卡上没有旧的 Add model；`models.saveModel` 没有 `adding`，Edit 里没设过强度的模型显示 `defaultThinkingLevel` | App |
| MD-11 | 首次启动 | 填地址和 key → Fetch → 勾一个模型 → Test connection → 进入主窗口（Open a folder 提示里一行“Connected · …”）→ Open folder（探针进度在会话的拒绝启动卡上，2026-10-26 按负责人走查 M2 改写），默认范围是这个模型；勾两个时默认范围是提供商，Test connection 测第一个；有探针代价的一句、没有关闭表单的 Cancel；保存后改地址再拉取用内存里的 key（`FAKE_REQUIRE_KEY` 下不出 `rejected`；地址只改路径、origin 不变；改到另一个 origin 时拉取不带内存里的 key、占位回到 Optional（2026-10-23 负责人决定，§6.6））；再次保存（测试失败或已取消之后）整体替换，配置里仍只有一个提供商；列表错误时手填仍可完成 | App |
| MD-12 | 第 0 步与档案 | 第 0 步经读取器得出种类、窗口与 `meta`（`sglang`、`ollama`、`rich` 三种形状）；Ollama 只有训练窗口时 `reported` 窗口为 null；一次加入 3 个模型时列表只读一次、每个档案都有种类与 `meta`，期间点 Fetch models 或 Cancel 不取消探针；没有 `meta` 的旧档案照样读、不重新探测；Ollama 有报告窗口后有效窗口取较小的；读版本每个提供商一次，合成端点日志里没有 §4.2 的路径（`ollama` 形状：没有 `/api/tags`、`/api/ps`、`/api/show`；`sglang`：没有 `/model_info`）；`localai`、`tensorrt` 形状认出后重新探测一次、不显示 Cancel test…（2026-10-26 注：Cancel test… 已从模型行删掉，这半句不再检查；Ollama 有效窗口变小只查档案，模型行不再列 Context） | 单元、App |
| MD-13 | 模型行提示 | 没报告的窗口与输出写 not reported（2026-10-26 改为“(default)”：只在值仍等于默认值时，§8；Ollama 只有训练窗口的不标）；§8 表的每一行的显示条件与 Use 的改动（窗口改小时 Max output 一起改；`-alwaysthink` 给第四行）；Use 后重新探测；旧档案只显示第四行 | App、回放 |
| MD-14 | 真实端点 | DeepSeek：列表读出窗口、输出上限、思考、图片，与官方文档一致，勾选加入后探针完成；OpenRouter：几百个模型的清单可过滤，加入一个；GLM：拿到列表或显示列表错误，手填 `GLM-5.3` 后加入并完成探针；录下 §13.1 的真实样本与回放 fixture | 真实 |
| MD-15 | 现有功能不退步 | §13.4 改过的现有测试与模型层规格 §14.4 的全部现有套件通过 | App、回放 |

### 13.3 不留未完成项

`tests/spec-coverage.mjs` 加规格 `discovery`：读本文 §13.2（编号 `MD-n`），层的结果文件为 `md-unit.json`（单元）、`md-app*.json`（App，含 `-existing`）、`md-replay*.json`（回放，含 `-existing`）、`md-real.json`（真实），`md-partial-*.json` 不计入。

`npm run test:discovery` 依次跑 `test:md-unit`、构建、`md-app-*.mjs`、`md-replay.mjs`、`v1-models-existing.mjs --id MD-15`，最后 `node tests/spec-coverage.mjs --spec discovery --allow-missing-real`。
真实层（MD-14）要用你的数据目录和 key，由你跑 `md-real.mjs`；最终一遍不带 `--allow-missing-real`。

`tests/ui/v1-models-existing.mjs` 加套件组 `discovery` 和预设 `MD-15`（照 `MEM-35` 的写法）：
`discovery` 组 = `memory` 组（v0 各里程碑、模型层与 TaskBoard 的现有套件）再加记忆的 App 套件（`mem-app-*.mjs`）、`mem-replay.mjs` 与 `test:mem-unit`；
App 结果写 `md-app-existing.json`，回放结果写 `md-replay-existing.json`，部分运行的前缀 `md-partial-existing-`，日志目录 `md-existing`，先跑 `test:unit`；
同时按 `also` 另写 `MP-37`、`TB-46`、`MEM-35` 的结果文件，最后依次跑 `spec-coverage --spec model`、`--spec taskboard`、`--spec memory --allow-missing-real`，
各记一条“MD-15 spec-coverage-<规格>”。

### 13.4 现有测试

（2026-10-23 注：实现后按实际改动重写。下表列出这次改到的每个现有测试文件——`git diff --name-only 54f0758 -- app/tests` 里不是新加的那些；
新加的 `md-*` 文件、`tests/unit/discovery/`、`tests/fake-endpoint/discovery.mjs` 与 fixture 不在表里——和改了什么；最后一段写没改的。）

| 现有 | 改法 |
| --- | --- |
| `tests/ui/page.mjs`（首次启动与加模型的共用操作，大多数 App 测试经它） | 首次启动：填 Base URL 和 API key → Fetch models → 勾 `fake-coder`（合成端点列表两行、类型不明，默认都不勾）→ Name 仍填“Mori endpoint”（有几十处按 `mori-endpoint` 引用）→ 区域选 Local → Test connection；其余同现在。新加三处共用的操作：`fetchIn`（点 Fetch models，等这次的清单、列表错误或命令失败的原文）、`pickIn`（只勾给出的模型，清单里没有的用 Add a model ID 手填，再按需改 Context window、Max output、Supports thinking、Image input）、`cardAddModels` 与 `h.addModels`（卡上 Fetch models → 勾选或手填 → Add N models）。`fillConnection` 在 Base URL、API key 改了或还没拉取过时 Fetch models，返回这次拉取的结果；`firstRun` 另返回拉取结果和手填的模型；`setupFirstRun` 在拉取没拿到列表、或勾的模型是手填的时报错（对的 key 拉取失败时不悄悄改成手填） |
| `m0-smoke.mjs`、`m1-app.mjs` | 首次启动照 `page.mjs` 的新写法。Name 必填的检查改到拉取之后（清单里勾着 `fake-coder`，只差 Name；`m1-app.mjs` 的小字检查也看拉取后的清单与字段）；错的 key 在 Fetch models 时就得到 `list-error`（`rejected`），再手填 `fake-coder`、测试连接看 401 原文；换回对的 key 后检查拉取拿到列表、`fake-coder` 是在清单里勾的。`m1-app.mjs` 卡上加 `fake-slow` 改为卡上 Fetch models → 勾 `fake-slow` → Add 1 model（`h.addModels`）；主进程被强行结束的一步（`mainKilled`）的首次启动改用 `setupFirstRun` |
| `m6-app-settings.mjs` | 首次启动表单上的 Supports thinking 检查改到拉取后清单里 `fake-coder` 一行的勾选框 |
| `m2-app.mjs`、`m6-helpers.mjs` | 准备一步的首次启动另查 Fetch models 拿到了列表：`m2-app.mjs` 记进检查（另查 `fake-coder` 不是手填的）；`m6-helpers.mjs` 的 `firstRunAndOpen` 没拿到列表时报错，模型不在列表里时照样手填（`m6-app-slash.mjs` 的长模型 id） |
| `v1-models-app-session.mjs` | MP-10 的 `addModelUi` 改为卡上 Fetch models → 勾选或手填 → Add 1 model（`cardAddModels`）；合成端点日志里带 `path` 的列表与详情请求行（§13.1）不算对话请求，不收集 |
| `v1-models-app-settings.mjs` | Add provider 与首次启动表单改为 Base URL 和 API key → Fetch models → Name、区域 → 清单里勾（`fetchIn`、`pickIn`）；MP-33 的改模型 id 改为在清单里换勾的模型；MP-24 的兼容选项先 Fetch models 再点开 More settings，加模型改用 `cardAddModels`；关表单按 `data-action="close-form"`；MP-08 的区域建议现在每个地址都要先拉取一次（不带 key），所以只用连不到任何真实服务的地址（本机 9 号端口、解析不到的主机名、RFC 5737 与 RFC 6761 的地址），内网网段的取值只由单元测试 `tests/unit/shared-models.test.mjs` 检查；合成端点日志里带 `path` 的行不收集 |
| `v1-models-app-switch.mjs` | 经进程桥加模型的 `models.saveModel { adding: true }` 改发 `models.addModels`；改模型的 `models.saveModel` 去掉 `adding: false` |
| `tests/ui/tb-helpers.mjs`、`tests/ui/v1-switch-helpers.mjs`（TaskBoard、记忆与模型层的 App 测试共用） | 收集合成端点日志时丢掉带 `path` 的列表与详情请求的 JSON 行（§13.1），只记对话请求 |
| `m1-real.mjs`、`m6-real.mjs`、`m0-real.mjs` | `m1-real.mjs` 首次启动照 `page.mjs`（key 栏留空，要 key 的服务拉取时为 `rejected`，这时手填）；`m6-real.mjs` 走查 1 加模型改为卡上 Fetch models → 勾（或手填）→ Add 1 model；`m0-real.mjs` 只改给你看的说明（先 Fetch models 再勾模型） |
| `m6-record.mjs`、`v1-models-record.mjs` | `m6-record.mjs` 的 model-range 加模型改发 `models.addModels`；两个文件里改模型的 `models.saveModel` 都去掉 `adding` |
| `tests/ui/m6-replay.mjs` | 走查 8（markReasoning）：Edit 里没设过强度时显示录下的 `thinkingDefaults`，没有时 `config.get` 的 `defaultThinkingLevel`（再没有时 Medium）；检查 `models.saveModel` 没有 `adding`，强度与显示的相同时不带 `thinkingLevel`、不同时带上（§5.4） |
| `tests/ui/harness/replay.js` | `models.discover` 是按参数配对的只读查询（新提供商按 kind、去掉首尾空白的 baseUrl、api，已有提供商按 providerId；`keySecret` 不参与），没录过时合成一个命令失败的结果（synthetic）；`models.addModels` 照其他 `models.*` 写命令应答；`models.discoverCancel` 应答 `{ error: null }`，不算写命令；`models.get`、`models.reload` 按界面已发的写命令条数取录制里对应的那一个（录制里没有写命令时同原来，取这一段最后一个） |
| `tests/ui/harness/main.jsx` | 加载 `fixtures/discovery/ui/*.json`（§13.1） |
| `tests/unit/probes.test.mjs` | 第 0 步的用例（四个固定 GET、`judge({ apiVersion })` 认作 Ollama、`judge({ props })` 认作 llama.cpp、`VLLM` 样本的 `owned_by: 'fake'`、没有版本时版本为 unknown）按 §3.3 改写并移到 `tests/unit/discovery/profile-step0.test.mjs`，名字仍以 MP-10、MP-12 开头；这里的第 0 步改用替身 `readServer`，另加一条：第 0 步中取消时返回 null、不发第 1–7 步的请求 |
| `tests/unit/modelProfiles.test.mjs` | MP-12 的 `versionChanged` 改收读版本的结果 `{ listed, kind, version, versionRead }`（§7.3） |
| `tests/unit/reporter.mjs`、`tests/spec-coverage.mjs`、`tests/unit/taskboard/spec-coverage.test.mjs` | 报告器加严格模式（`md-reporter.mjs` 用：跳过的与标为待办的测试、套件自己的失败都记为失败）；覆盖检查加 `--spec discovery`（§13.3），带跳过或待办标记的检查一律不算通过；TB-46 的单元测试加查 `--spec discovery` 读到 §13.2 的每个 MD 条目与层、`md-` 结果文件归到哪一层（`md-partial-*` 不算），带标记的检查不算通过，以及严格模式的报告器把跳过的、待办的测试与套件自己的失败记为失败、不开严格模式时照旧 |
| `tests/ui/v1-models-existing.mjs` | 加套件组 `discovery` 和预设 `MD-15`（§13.3），最后一项附加检查是 `tests/md-markers.mjs`（这次新加的行里没有推迟实现的标记） |
| `tests/fake-endpoint/server.mjs`、`probes.mjs`、`selfcheck.mjs` | `server.mjs`：默认形状只把列表行的 `owned_by` 改成 `vllm`（§13.1），加 §13.1 的其他行为（形状在新加的 `discovery.mjs`），文件开头注释照改；`probes.mjs` 只改开头注释（`-alwaysthink` 在 `server.mjs` 里处理）；`selfcheck.mjs` 加 §13.1 发现行为的自检 |
| 模型层规格 §14.2 | MP-01、MP-10、MP-24、MP-33 的条目文字不变，测试按新流程写；在那边 §14.4 注明 |

没改的：`m3-app.mjs`、`m4-app.mjs`、`m5-app.mjs`、`m6-app-mcp-shared.mjs`、`m6-app-tools.mjs`、`m6-app-slash.mjs`
的首次启动经 `page.mjs` 的 `setupFirstRun` 或 `m6-helpers.mjs` 的 `firstRunAndOpen`，随它们改，文件本身不用改；
`mem-app-settings.mjs` 只等首次启动表单出现、在上面按 F8，不填表单；回放套件除 `m6-replay.mjs` 外都没改
（回放桥 `harness/replay.js` 按上表改）。
TaskBoard 与记忆的 App 测试直接写 `model-config.json` 准备配置，不填首次启动表单，也不发 `models.saveProvider`、`models.firstRun`、
`models.saveModel`；它们要改的只有上面 `tb-helpers.mjs`、`v1-switch-helpers.mjs` 两个 helper：合成端点现在也给列表与详情请求打
JSON 行（§13.1），收集时跳过带 `path` 的行。

（2026-10-26 注，负责人走查 M1、M6、M7（WP-02）：清单与模型行的“Not reported”“(not reported)”改为“Default”“(default)”（标识 `default-value` 取代 `not-reported`），只在值仍是默认值时写；`md-app-form`、`md-app-firstrun`、`md-app-card`、`md-replay` 与几个 helper 随之改，模型行的 Tool calling 改读行的 `data-probe`，`md-app-card` 删掉“不显示 Cancel test…”与读行上 Context 的两处，`trained_window` 提示的文字改短，MD-09 的兼容选项改为五个加一行说明。逐条见 docs/v1/walkthrough-1026/WP-02.md。）
（2026-10-26 注，负责人走查 M2：首次启动测试成功就进入主窗口，表单下方的探针状态与 Open folder… 删掉。`page.mjs` 的 `firstRun` 改为成功时读主窗口 Open a folder 提示里的 `connected`、失败时读表单的 `form-message`，`waitProbes` 经进程桥读 `models.get` 的档案；`md-app-firstrun.mjs` 里要留在表单上的保存（内存里的 key、再次保存）改为测试失败之后（`-404` 后缀的模型），探针状态的检查移到会话的拒绝启动卡；改法逐条见 docs/v1/walkthrough-1026/WP-01.md。）
