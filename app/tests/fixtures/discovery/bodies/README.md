# 拉取模型的响应体样本

给读取器（`src/kernel/discoverRead.ts`、`src/kernel/modelDiscover.ts`）的单元测试（规格 [model-discovery.md](../../../../../docs/specs/model-discovery.md) §13.1，MD-02、MD-03、MD-04）直接喂的响应体。
更新日期：2026-10-23。

## 文件格式

每个文件是一个响应，外层和真实录制一样：

| 字段 | 含义 |
| --- | --- |
| `source` | `real`（真实录制）或 `synthetic`（手写） |
| `synthetic` | 只在手写的文件里，为 `true`（AGENTS.md 第 5 条） |
| `recorded` | 真实录制为录制日期；手写为写成的日期 |
| `url` | 这个响应对应的请求地址（Ollama 的 `/api/show` 是 POST，正文 `{"model": <id>}` 写在 `note` 里） |
| `note` | 一句说明 |
| `basis` | 只在手写的文件里：核对形状时看过的上游源码或文档地址；没能核对的写明“NOT verified” |
| `status` | HTTP 状态 |
| `headers` | 只在靠响应头认出种类的文件里（New API 的 `X-New-Api-Version`） |
| `body` | 响应体（JSON；真实录制里服务回的是文字时为字符串） |

录制脚本和手写样本都只存响应体、状态（和上面那个响应头），不存请求头。
自建服务的手写样本用 `192.0.2.0/24`（RFC 5737 的文档地址）当主机；云服务用它的真实主机名，因为 §3.3 第 2 步按主机认种类。
样本里的模型 id、版本号、数值是示意值，形状（字段名、嵌套、类型、固定值）按 `basis`。

## 真实录制

| 文件 | 录制 | 地址 | 内容 |
| --- | --- | --- | --- |
| `openrouter-models.json` | 2026-10-23 | `https://openrouter.ai/api/v1/models` | 公开列表，不带 key，468 个模型 |
| `deepseek-models-nokey.json` | 2026-10-23 | `https://api.deepseek.com/models` | 不带 key：401，原文 `Authentication Fails (governor)` |
| `glm-models-nokey.json` | 2026-10-23 | `https://open.bigmodel.cn/api/paas/v4/models` | 不带 key：401；不能说明 GLM 有没有列表接口（proposal §14） |
| `deepinfra-models.json` | 2026-10-23 | `https://api.deepinfra.com/v1/openai/models` | 公开列表，不带 key；从 176 行里截了 5 行，行内容不改（规格 §13.1 写的是手写，这里有可用的公开接口，就用真实录制） |
| `deepseek-models.json` | 2026-10-23 | `https://api.deepseek.com/models` | 带 key：200，2 个模型（`deepseek-flash`、`deepseek-v4-pro`），每行有 `context_window`、`max_output_tokens`、`input_modalities`、`output_modalities`、`effort`、`api_capabilities`；值与 DeepSeek 文档一致（窗口 1048576、输出上限 393216，`deepseek-flash` 收图片）。取代原来照文档样例手写的同名文件（手写版没有 `api_capabilities.anthropic_messages.tool_update`，其余相同） |
| `glm-models-1.json` | 2026-10-23 | `https://api.z.ai/api/anthropic/v1/models?limit=1000` | 带 key：§3.2 有 Anthropic 提示时的第 ① 个列表地址，200，11 个模型（`glm-4.5` … `glm-5.3-flashx`，id 全是小写），行只有 `id`、`display_name`、`created_at`、`type: "model"`；顶层的翻页字段是驼峰的 `hasMore`（假）、`firstId`、`lastId`。按 §3.2、§3.3 的规格更正（规划会话，2026-10-23：对象有 `has_more` 或 `hasMore` 即为 Anthropic 形状，游标取 `last_id` 或 `lastId`）读取器得出 `anthropicShape` 真、种类 `unknown`（Detected 写 Anthropic-compatible server）、不翻页、`api` 为 Anthropic Messages；`hasMore` 改为真的两页（synthetic，由它分成）带 `after_id=<lastId>` 读第 2 页（`tests/unit/discovery/rules-camel.test.mjs`）。录制时的读取器还只认 `has_more`，所以同一次运行的 `../ui/md-glm-card.json` 里是 `anthropicShape: false` |

带 key 的两份由 MD-14 的 record 录下（规格 §13.2，`tests/ui/md-real.mjs` 的 key 方式，2026-10-23 在这台机器上跑）：key 只输进 Mori 的 API key 框、由 Mori 加密保存；
卡上的 Fetch models 用保存的 key，经本机 127.0.0.1:4881 的转发代理发出，代理只留列表请求的状态与响应体（响应体里出现 key 时换成 `***`），不存请求头和响应头。
`glm-models-<n>.json` 的 n 是 §3.2 的列表地址的顺序；这次第 ① 个就拿到了列表，所以只有 `glm-models-1.json`。
同一次运行从真实的 App 录下的卡上拉取在 `../ui/md-deepseek-card.json`、`../ui/md-glm-card.json`（md-replay.mjs 回放）。

## 手写样本

“规格应得”一栏是按规格 §3.3、§4.1、§4.2 推出来的结果，单元测试照它写断言（窗口 / 输出上限没写“报告”的就是默认值：128000、16384 与窗口一半中较小的）。

### 按 `owned_by` 认的自建服务（§3.3 第 3 步）

| 文件 | 地址 | 内容 | 规格应得 | 依据 |
| --- | --- | --- | --- | --- |
| `vllm-models.json` | `192.0.2.10:8000/v1/models` | 基础模型 + LoRA 行（`parent` 为基础模型、`max_model_len` 为 null） | `vllm`；两行窗口都是 32768（LoRA 用 parent 的，§4.1） | vLLM `serve/engine/protocol.py`、`openai/models/serving.py` |
| `vllm-version.json` | `192.0.2.10:8000/version` | `{"version"}` | 版本 0.32.0 | vLLM `serve/instrumentator/basic.py` |
| `sglang-models.json` | `192.0.2.11:30000/v1/models` | 基础模型 + LoRA 行 | `sglang`；LoRA 窗口取 parent 的 40960 | SGLang `openai/protocol.py`、`http_server.py` |
| `sglang-model-info.json` | `192.0.2.11:30000/model_info` | `reasoning_parser: "qwen3"`、`tool_call_parser: null`、`has_image_understanding: false` | 只并进 parent 为 null 的行：思考真、图片明确没有、`no_tools`；LoRA 行不并 | SGLang `http_server.py` 的 `model_info` |
| `sglang-models-embedding.json`、`sglang-model-info-embedding.json` | `192.0.2.31:30000` | embedding 服务：`is_generation: false`、两个解析器都是 null | `chat` 假、思考明确没有、`no_tools` | 同上 |
| `llamacpp-models.json` | `192.0.2.12:8080/v1/models` | 单模型模式：`models`（Ollama 式）+ `data`（`meta.n_ctx`、`architecture.input_modalities`） | `llamacpp`；窗口 8192（`meta.n_ctx`）、图片真 | llama.cpp `tools/server/server-context.cpp`、`server-common.cpp` |
| `llamacpp-props.json` | `192.0.2.12:8080/props` | 单模型模式：`default_generation_settings.n_ctx`、`modalities.vision`、`build_info` | 版本 `b9104-6d1f0a2`；`modalities.vision` → 图片 | `server-context.cpp` 的 `get_res_props`、`common/build-info.cpp.in` |
| `llamacpp-router-models.json` | `192.0.2.13:8080/v1/models` | router 模式：已加载（`context_length` 40960 = `n_ctx_train`，另有子进程的 `meta.n_ctx` 16384）、未加载有 / 无 `context_length`、未下完 | 窗口依次 16384（§4.1 的顺序 `meta.n_ctx` 在 `context_length` 前，规格更正 2026-10-23）、131072、没报告、没报告；图片都明确没有 | `server-models.cpp` 的 `get_router_models`、`server-models.h` |
| `llamacpp-router-props.json` | `192.0.2.13:8080/props` | router 模式不带 `?model=`：`n_ctx` 为占位的 0 | 0 不算（§4.2“大于 0 才算”）；版本照读 | `server-models.cpp` 的 `get_router_props` |
| `xinference-models.json` | `192.0.2.16:9997/v1/models` | `model_type`、`model_ability`、`model_family`、`context_length`；含只能 `generate` 的 LLM 和 embedding | 思考、图片、工具都按 `model_ability` 读（含明确没有）；只 `generate` 的、embedding 的 `chat` 假；embedding 窗口没报告 | Xinference `api/restful_api.py`、`model/llm/llm_family.py`、`model/embedding/core.py` |
| `gpustack-models.json` | `192.0.2.17/v1/models` | 不带 `with_meta`：`meta` 为 null | `gpustack` | GPUStack `routes/openai.py`、`worker/model_meta.py` |
| `gpustack-models-meta.json` | `192.0.2.17/v1/models?with_meta=true` | `meta` 分别来自 vLLM（`max_model_len`）、llama-box（`n_ctx`）、MindIE（`max_total_tokens`） | 窗口 32768、16384、2560、8192（§4.2 按 `meta.*` 读） | 同上 |
| `mindie-models.json` | `192.0.2.18:1025/v1/models` | `owned_by: "MindIE Server"` | `mindie` | 昇腾文档 mindie_service0320 |
| `mindie-config.json` | `192.0.2.18:1025/v2/models/llama3-70b/config` | 顶层 `max_seq_len` | 窗口 2560 | 昇腾文档 mindie_service0083（文档说这个接口计划废弃） |
| `lmdeploy-models.json` | `192.0.2.20:23333/v1/models` | 只有 id | `lmdeploy`；什么都没报告 | LMDeploy `serve/openai/protocol.py`、`serve/openai/endpoints/models.py` |
| `tensorrt-models.json` | `192.0.2.22:8000/v1/models` | `owned_by: "tensorrt_llm"` | `tensorrt`，不是 `vllm` | TensorRT-LLM `serve/openai_protocol.py`、`serve/openai_server.py` |
| `tensorrt-version.json` | `192.0.2.22:8000/version` | 和 vLLM 一样的 `{"version"}` | 不读（`tensorrt` 没有版本请求，版本为 null） | `serve/openai_server.py` |

### 第 6 步认的自建服务

| 文件 | 地址 | 内容 | 规格应得 | 依据 |
| --- | --- | --- | --- | --- |
| `ollama-v1-models.json` | `192.0.2.14:11434/v1/models` | 4 个模型，`owned_by: "library"`、`created`（等于 `/api/tags` 里 `modified_at` 的 Unix 秒） | 配合 `ollama-api-version.json` 认作 `ollama` | Ollama `openai/openai.go` |
| `ollama-api-version.json` | `192.0.2.14:11434/api/version` | `{"version"}` | 版本 0.40.9 | Ollama `server/routes.go` |
| `ollama-tags.json` | `192.0.2.14:11434/api/tags` | 带 `capabilities` 和 `details.context_length` 的版本 | 见下面“Ollama 的四个模型” | Ollama `api/types.go`、`server/model_list.go`、`types/model/capability.go` |
| `ollama-tags-nocaps.json` | 同上 | 老版本：没有 `capabilities` 和 `details.context_length` | 结果同上（从 `/api/show` 取） | 同上；proposal §7 |
| `ollama-ps.json` | `192.0.2.14:11434/api/ps` | 只有 `qwen3:8b` 已加载，`context_length` 8192 | | Ollama `api/types.go` |
| `ollama-show-qwen3-8b.json`、`ollama-show-gemma2-9b.json`、`ollama-show-llava-7b.json`、`ollama-show-nomic-embed-text.json` | `192.0.2.14:11434/api/show`（POST） | `parameters`（Modelfile 参数）、`model_info`（训练窗口）、`capabilities` | | Ollama `api/types.go`、`docs/api.md` |
| `lmstudio-v1-models.json` | `192.0.2.15:1234/v1/models` | `{id, object, owned_by}`，没有 `created`；最后一行是已加载实例的 id `qwen3-8b-32k` | 配合下一个文件认作 `lmstudio` | **行的形状没核实**：文档只写了请求；列表里出现实例 id 也没核实 |
| `lmstudio-api-v1-models.json` | `192.0.2.15:1234/api/v1/models` | 已加载的 LLM、未加载的 LLM（一个 `trained_for_tool_use: false`）、embedding、以实例 id `qwen3-8b-32k` 加载的 `qwen/qwen3-8b` | 窗口 4096（已加载实例）、131072、32768、2048、32768（按 `loaded_instances[].id` 对上，取 `loaded_instances[0]`）；`type` → `chat`（embedding 为假） | lmstudio.ai/docs/developer/rest/list |
| `tgi-models.json` | `192.0.2.19:8080/v1/models` | 一行，`owned_by` 就是模型 id，`created` 0 | 配合下一个文件认作 `tgi` | TGI `router/src/server.rs`、`router/src/lib.rs` |
| `tgi-info.json` | `192.0.2.19:8080/info` | `router: "text-generation-router"`、`max_total_tokens` | 窗口 8192 | TGI `router/src/lib.rs`、`router/Cargo.toml` |
| `localai-models.json` | `192.0.2.21:8080/v1/models` | 行只有 `id`、`object`；`my model.gguf` 是没有配置的散文件 | `my model.gguf` 不能加入（the ID contains spaces） | LocalAI `core/http/endpoints/openai/list.go` |
| `localai-well-known.json` | `192.0.2.21:8080/.well-known/localai.json` | 带 `version`（`endpoints` 只留了几项） | 第 6 步第一个判断：`localai` | LocalAI `core/http/routes/localai.go`、`internal/version.go` |
| `localai-version.json` | `192.0.2.21:8080/version` | 和 vLLM 一样的 `{"version"}`，值是 `PrintableVersion` 的 `<版本> (<提交>)` | 不能因此认成 `vllm`；`localai` 不发版本请求 | 同上 |
| `localai-api-version.json` | `192.0.2.21:8080/api/version` | Ollama 兼容的固定 `0.9.0` | 不能因此认成 `ollama` | LocalAI `routes/ollama.go`、`endpoints/ollama/models.go` |
| `localai-models-capabilities.json` | `192.0.2.21:8080/v1/models/capabilities` | `capabilities`（含 `tools`、`thinking`）、`input_modalities`、`output_modalities`、`context_size`；散文件这三项为 null | 窗口取 `context_size`；思考、图片、工具、`chat` 按合并后的行读 | LocalAI `endpoints/openai/list_capabilities.go`、`core/schema/openai.go` |

Ollama 的四个模型（两份 `/api/tags` 结果相同）：

| 模型 | 窗口 | 其他 |
| --- | --- | --- |
| `qwen3:8b` | 8192，来自 `/api/ps`（报告值） | 思考真；图片明确没有；有 `tools`，没有提示；`chat` 真；族 `qwen3` |
| `gemma2:9b` | 4096，来自 Modelfile 的 `num_ctx`（报告值，比训练窗口 8192 小） | `no_tools`；`chat` 真 |
| `llava:7b` | 32768，只有训练窗口 | `trained_window` 和 `no_tools`；图片真；单模型模式（§7.2）`reported` 为 null |
| `nomic-embed-text:latest` | 2048，只有训练窗口 | `trained_window`、`no_tools`；`chat` 假 |

### 网关（§3.3 第 1、4、5 步）

| 文件 | 地址 | 内容 | 规格应得 | 依据 |
| --- | --- | --- | --- | --- |
| `litellm-models.json` | `192.0.2.23:4000/v1/models` | 每行 `created` 1677610602；`mode`、`max_input_tokens`、`max_output_tokens`；一行输出等于窗口；一行带 `supports_reasoning`、`supports_function_calling` 为 false | `litellm`；输出等于窗口的不算报告；LiteLLM 的 false 按没报告（没有 `no_tools`）；`mode: "embedding"` 的 `chat` 假 | LiteLLM `proxy/utils.py`、`constants.py`；**带 false 的那一行不在 main 分支的列表行里**，是为 §4.1 的规则加的 |
| `newapi-models.json` | `192.0.2.24:3000/v1/models` | 响应头 `X-New-Api-Version`、`success: true`、`supported_endpoint_types` | `newapi`（只有响应头或只有 `success` 时都是）；`chat` 依次 真、真、假、假、假；`api` 不变 | New API `controller/model.go`、`middleware/cors.go`、`relaykit/types/endpoint_type.go` |
| `newapi-models-anthropic.json` | `192.0.2.24:3000/v1/models?limit=1000` | New API 按 Anthropic 形状回答（没有 `success`，仍有响应头；`created_at` 是 1626777600 的 RFC 3339） | `newapi`、`anthropicShape` 真；已存的 Anthropic Messages 提供商 `api` 不变 | 同上；请求同时带 `x-api-key` 与 `anthropic-version` 时走这个分支（`router/relay-router.go`），即 §3.2 有提示、有 key 时的 ①；`dto` 的 json 字段名没核实 |
| `oneapi-models.json` | `192.0.2.25:3000/v1/models` | `created` 1626777600、`permission`；自定义模型的 `permission` 为 null、名字带空格 | `oneapi`（null 也算有 `permission` 字段）；带空格的不能加入 | One API `controller/model.go` |

### 按主机认的云服务（§3.3 第 2 步）

| 文件 | 地址 | 内容 | 规格应得 | 依据 |
| --- | --- | --- | --- | --- |
| `moonshot-models.json` | `api.moonshot.cn/v1/models` | `context_length`、`supports_image_in`、`supports_reasoning`（两行为 false） | `moonshot`；false 是明确没有 | platform.kimi.ai/docs/api/list-models（只有字段表，没有响应样例） |
| `dashscope-compatible-models.json` | `dashscope.aliyuncs.com/compatible-mode/v1/models` | OpenAI 形状的列表 | `dashscope` | **形状没核实**（proposal §14） |
| `dashscope-native-models-page1.json`、`dashscope-native-models-page2.json` | `dashscope.aliyuncs.com/api/v1/models?page_no=<n>&page_size=100` | `output.models[]`：`capabilities`（TG、VU、Reasoning、IG、TR）、`features`、`inference_metadata`、`model_info`；第 1 页是 100 个的满页（见下面“百炼翻页”），第 2 页 1 个，`total` 101 | 窗口、输出上限按 `model_info`；`Reasoning` → 思考；`VU` → 图片，`request_modality` 不含 `Image` 的其余模型图片明确没有（§4.2 规格更正 2026-10-23）；没有 `function-calling` → `no_tools`；有 `TG` 才是聊天模型；读第 1、2 页，不读第 3 页 | help.aliyun.com/zh/model-studio/list-models；proposal §14 |
| `dashscope-native-models-single.json` | `dashscope.aliyuncs.com/api/v1/models?model=qwen3.8-max` | 单模型模式（§7.1、D14） | 窗口 131072、输出上限 16384、思考真、图片明确没有（`meta.image` 为 false） | 同上 |
| `qianfan-models.json` | `qianfan.baidubce.com/v2/models` | `max_input_tokens`（窗口）与 `max_tokens`（输出上限） | `qianfan` 时读 `max_tokens`；不小于窗口的不算 | **字段名没核实**：没找到文档；2026-10-23 不带 key 请求回 429 OverRateLimit |
| `anthropic-models-page1.json`、`anthropic-models-page2.json` | `api.anthropic.com/v1/models?limit=1000`（第 2 页加 `&after_id=claude-sonnet-5-5`） | `has_more`、`last_id`；`capabilities.thinking.supported`、`capabilities.image_input.supported`、`max_input_tokens`、`max_tokens`；每页两行只为测翻页（`limit=1000` 时一页最多 1000 行） | `anthropic`、`anthropicShape` 真、翻页；最后一行思考明确没有 | platform.claude.com/docs/en/api/models/list |

### 没有按域名认出的（第 7 步 `unknown`）

| 文件 | 地址 | 内容 | 规格应得 | 依据 |
| --- | --- | --- | --- | --- |
| `together-models.json` | `api.together.xyz/v1/models` | 顶层数组；`type`（chat、language、embedding、image）、`context_length`（图片模型为 0） | 数组也是模型列表；`type` → `chat`；0 不是正整数 | Together `together-python` 的 `types/models.py`、`resources/models.py` |
| `mistral-models.json` | `api.mistral.ai/v1/models` | `capabilities` 的布尔、`max_context_length`、`type: "base"` | 窗口、思考、图片、`no_tools` 按 `capabilities` 读；`chat` 按 `capabilities.completion_chat`（§4.1 规格更正 2026-10-23：排在 `type` 前）：前三行真，`mistral-embed` 假 | Mistral `client-python` 的 `models/basemodelcard.py`、`models/modelcapabilities.py` |
| `openai-compatible-edge-rows.json` | `192.0.2.30:8000/v1/models` | 不是哪一个服务：§3.2、§4.1、§4.3 要的边角行——只含数字的字符串、重复 id、空 id、带空格的 id、明确报告“没有”、输出不小于窗口、`type: "model"`、`type: "embedding"` | 重复的只留第一行；空 id 和带空格的不能加入；`type: "model"` 不看 | 规格 §3.2、§4.1、§4.3 |

## 百炼翻页

读取器读到一页少于 100 个模型就停（A11），所以 `dashscope-native-models-page1.json` 是 100 个模型的满页：前 4 个是有说明的模型，
`filler-model-005` 到 `filler-model-100` 是只有 `model`、`capabilities`、`model_info` 的填充行（synthetic，不对应真实模型，
也不在 compatible-mode 的列表里，不会并进任何一行）。读取器因此再读第 2 页，第 2 页的 `deepseek-v4-pro` 并进列表行；
第 2 页只有 1 个，不再读第 3 页。

## 和当前读取器对过（2026-10-23）

把上面每个样本按种类配好响应，经替身 fetch 交给当前的 `DiscoverReader.command`、`single`、`version`（esbuild 打包到仓库外的临时目录），
逐项比“规格应得”（种类、版本、`baseUrl`、`api`、`anthropicShape`、`listError`，每个模型的窗口、输出上限、思考、图片、族、`chat`、
`reported`、提示、`unusable`），再比每个场景发出的请求（第 6 步的响应不重复请求、§4.2 的详情、§7.1 单模型只读这个模型的详情、
§7.3 读版本不发详情请求、`localai` 与 `tensorrt` 不发 `/version`）与认证头（D1、D2）：1767 项没有不一致。
OpenRouter 的真实样本每一行都按 §4.1 独立算过一遍，与读取器一致。

## 已知问题（规格层面，不是读取器的错）

1. **Mistral 全部判为不是聊天模型**（已由规格更正解决，2026-10-23）：Mistral 的每一行都有 `type: "base"`（SDK 里是常量）；
   §4.1 的 `chat` 现在先看 `capabilities.completion_chat`，再看 `type`，所以按 proposal §7 照通用规则读到。
2. **llama.cpp router 模式已加载的模型报的是训练窗口**（已由规格更正解决，2026-10-23）：router 给每行写 `context_length` = `n_ctx_train`，
   子进程的 `meta.n_ctx`（实际在用的）只在没有同名字段时并进来；§4.1 的路径顺序现在 `meta.*` 在 `context_length` 前，所以窗口取 `meta.n_ctx`。
3. **DeepInfra 的输出上限不在 §4.1 的路径里**：它写在 `metadata.max_tokens`（每行都等于 `metadata.context_length`），§4.1 只在 Anthropic 形状和千帆时读顶层 `max_tokens`，
   结果同样是“没报告”，但 MD-03 举它作“不小于窗口的不算报告”的样本并不会走到这条规则。DeepInfra 的 `metadata.tags` 里的 `chat`、`embed` 也不在 `chat` 的规则里，所以全部为 null。
4. **SGLang 的版本**：SGLang main 分支的 `http_server.py`（2026-10-23）没有 `/version`，版本在 `/server_info` 的 `version` 里；按 §3.3 读 `/version` 会得到 null。
5. **百炼原生列表顶层有 `success: true`**：它是详情请求，不经 §3.3 第 1 步；但 compatible-mode 的 `/models` 若也带 `success: true`（没核实），会在第 1 步被认成 `newapi`。
6. **百炼的“明确没有”**（已由规格更正解决，2026-10-23）：§4.2 百炼一行现在写明 `inference_metadata.request_modality` 原样合并进行、按 §4.1 读，
   所以纯文字的 `qwen3.8-max` 等图片为“明确没有”（`reported.image` 真、`image` 假，单模型模式 `meta.image` 为 false）；
   `capabilities`、`features`、`model_info` 不原样合并，只按 §4.2 的对应。
7. **LiteLLM 的布尔假**：main 分支 `/v1/models` 的行（`proxy/utils.py` 的 `create_model_info_response`）只有 `id`、`object`、`created`、`owned_by`、
   `mode`、`max_input_tokens`、`max_output_tokens`，没有 `supports_*`；`litellm-models.json` 里带 false 的那一行是为 §4.1 的规则手加的。
