// 合成测试端点（synthetic）：只用于本地验证管线，不是真实模型。
// 实现 OpenAI 兼容的 /v1/models 与流式 /v1/chat/completions，另有 /version（docs/specs/model-providers.md §14.1），
// 以及一键拉取模型要的各种列表形状与详情接口（docs/specs/model-discovery.md §13.1，见下面的“发现”）。
// 多个提供商 = 多个端口（各起一个进程）。关键词回复在 replies.mjs，探针在 probes.mjs，脚本模式在 scripts.mjs，
// 增强脚本在 enhance.mjs，列表与详情的形状在 discovery.mjs。
//
// 判断顺序：认证 → -nooff 的拒绝 → -replay 的拒绝 → 探针 → -404、-hang、-stall → pi 的压缩请求 → 脚本模式 → 增强脚本
// → 关键词。
// 路由只看路径的结尾（2026-10-24 补，§14.1）：对话 = POST 路径以 /chat/completions 结尾，列表 = GET 路径以 /models 结尾
// （见下面的“发现”），所以任何路径前缀下都是同样的接口。pi 只在地址含 openrouter.ai 时用 OpenRouter 的写法
// （思考写成 reasoning: {effort}，关闭思考写成 reasoning: {effort: "none"}），测试的提供商地址因此写
// http://127.0.0.1:<端口>/openrouter.ai/v1：/openrouter.ai/v1/models 与 /openrouter.ai/v1/chat/completions 照常回答；
// /version 等仍在 origin 下（内核按 origin 去请求它们）。
// 增强脚本（docs/specs/memory.md §14.1，规则逐条列在 enhance.mjs 开头）：请求里没有 tb-scenario、最后一条用户消息是
// 增强会话的第一条消息（附录 B 的第一句开头），且 FAKE_ENHANCE_SCRIPT 指向的脚本文件里有这种时按脚本回复；
// 这时同样不用下面的关键词规则与故障关键词。
// 脚本模式（docs/specs/parallel-agents-taskboard.md §17.1，规则逐条列在 scripts.mjs 开头）：请求里出现 "tb-scenario:<名字>"
// 时按那个场景的脚本回复，不用下面的关键词规则，也不用 http-NNN、overflow-once、slow、drop-after-first 这些故障关键词。
// "最后一条用户消息"不算只有工作卡（<mori-work-card>…</mori-work-card>）的那条。
//
// 回复内容由下列规则决定（关键词都在最后一条用户消息里）：
//   - 最后一条是工具结果，且以 "Rejected" 开头（Mori 拒绝时回给模型的固定写法）：回复"收到拒绝："加结果的前 60 个字。
//   - 最后一条是其他工具结果：流式返回一段摘要文字后结束。
//   - 用户消息含 "two commands: <命令一> ;; <命令二>"：同一条回复里调用两次 bash 工具
//     （tool_calls 的 index 为 0 和 1，id 不同），用来测一条回复里的多个调用。
//   - 用户消息含 "call then write: <命令>"：同一条回复里先调用 bash 工具执行该命令，调用之后再流出一段很长的正文
//     （测步骤组：组后面有正文、调用还在等批准时不折起；折起时的滚动，2026-10-26）。
//   - 用户消息含 "run: <命令>"：调用 bash 工具执行该命令，可加 "timeout=<秒>"。
//   - 用户消息含 "write file: <路径>"：调用 write 工具，把 "hello from mori\n" 写入该路径。
//   - 用户消息含 "edit README"：调用 edit 工具修改 README.md 的标题（"# Smoke project" 或 "# Mori fixture project"，
//     由 "edit README: <原标题>" 指定，默认 "# Smoke project"）。
//   - 用户消息含 "list tools"：回复"可用的工具："加请求里 tools 的全部工具名（逗号分隔），用来测项目扩展的工具有没有加载。
//   - 用户消息含 "call tool: <工具名>"：调用该工具，参数为空对象（例如项目扩展注册的 project_hello）；
//     工具名后面跟一段 JSON 对象时（"call tool: mcp__x__echo {"text":"hi"}"）用它作参数（M6）。
//   - 用户消息含 "agents check"：系统提示里有 MORI-AGENTS-<字母数字> 时回复"系统提示里有 <它>"，否则"系统提示里没有标记"
//     （M6：测用户级 AGENTS.md 进了新会话的系统提示）。
//   - 用户消息含 "which model"：回复"模型：<请求里的 model>"（M6：测范围菜单换模型后新回复来自新模型）。
//   - 用户消息含 "thinking check"：开了思考（见下面探针一节最后一条）时先流式返回一段思考，再回复"收到思考参数：<值>"
//     （值为 reasoning_effort ?? reasoning.effort）；没开时只回复"没有思考参数"（M6：测思考强度，pi 对 OpenAI 兼容端点
//     在模型标了支持思考时才发这个参数）。
//   - 用户消息含 "wait <秒数>s then run: <命令>"：等这么多秒再调用 bash 工具执行该命令（测界面重新加载后才来的批准请求）。
//   - 用户消息含 "wait <秒数>s"：等这么多秒再回复一段文字（测生成中切走、"Unread"）。
//   - 用户消息含 "code block"：返回一段带 ts 代码块的 Markdown。
//   - 用户消息含 "mermaid diagram"：返回一段带 mermaid 流程图代码块的 Markdown（2026-10-26，测图离线画出）。
//   - 用户消息含 "echo back"：回复"收到的全文："加这条用户消息的全文（测引用块确实发给了模型）。
//   - 用户消息含 "long reply"：流式返回四段较长的文字（测生成中选字、反馈）。
//   - 用户消息含 "think first"：先流式返回一段思考（reasoning_content），再返回一句文字（测会话引用不含思考）。
//   - 用户消息含 "plain"：只返回文字。
//   - 用户消息含 "http-<状态码>"：每次都以该状态码返回错误（例如 http-500 是服务端错误，http-400 是请求错误）。
//   - 用户消息含 "http-<状态码>-once"：这个会话第一次以该状态码返回错误，之后按其他规则正常回复。
//   - 用户消息含 "overflow-once"：这个会话第一次返回 400，message "This model's maximum context length is 1000 tokens"、
//     code context_length_exceeded（pi-ai 的 overflow.js 认得这句），压缩后正常回复。
//     "会话"按第一条用户消息的哈希区分（去掉 Mori 重做时加在末尾的 "[Mori] ..." 说明），每个关键词每个会话只触发一次；
//     第一条用户消息已是 pi 的压缩摘要时，按最后一条用户消息的文字认出已经触发过。
//   - 用户消息含 "drop-after-first"：发出第一段内容后断开连接（有输出后中断）。
//   - 用户消息含单词 "slow"（独立的词，"mcp__shared__slow" 不算），或模型 ID 为 "fake-slow"：第一个分块前等 8 秒
//     （测"Test connection → Cancel"等）。
//   - pi 的压缩请求（系统提示是 pi 的摘要提示）：回一段纯文字摘要，不看关键词（摘要请求里是整段对话的文字）。
//   - 用量：prompt_tokens 按请求消息的字数估算，随对话增长。
//   - 其他：先说一句话，再调用 read 工具读取 README.md。
//
// 探针（§7.3 第 1–7 步，按最后一条消息认出）一律按"能力全通过"回答，先于上面的关键词：
//   - 第 1、2 步 "Reply with the single word: ready."：回 "ready"。
//   - 第 3 步 "Use the tool to get the weather for Paris for the next 3 days."（tools 里有 get_weather）：
//     调 get_weather {"city":"Paris","days":3}。
//   - 第 4 步 "What temperature did the tool report?"（或最后一条是工具结果 "Paris: 21°C, sunny for 3 days."）：回答含 21。
//   - 第 5 步 "Call submit_outcome with outcome banana."（tools 里有 submit_outcome）：调 submit_outcome {"outcome":"ok"}。
//   - 第 6 步 "Reply with JSON whose outcome is banana."：带 response_format json_schema 时回 {"outcome":"ok"}，
//     没带时回 {"outcome":"banana"}。
//   - 第 7 步：用户消息同时含 "<summary>" 与 "<outcome>"：回 "<summary>…</summary><outcome>ok</outcome>"。
//   - 开了思考时先返回一段 reasoning_content，没开时没有思考（-alwaysthink、-nooff 除外）。"开了思考"（2026-10-24 补，
//     §14.1；probes.mjs 的 thinkingOn）：请求带 reasoning_effort 或 reasoning.effort（取前者），且不是 "none"。
// 模型 ID 的后缀（以 "-" 分开的段，可以叠加，例如 fake-coder-stall-alwaysthink）：
//   - 只关掉对应的探针能力：-notools（第 3 步不调工具）、-nochoice（第 5 步忽略指定调用，只回文字）、
//     -noschema（第 6 步忽略 schema）、
//     -replay（开了思考时每次回复都带 reasoning_content；有带工具调用、没有 reasoning_content 的助手消息，且这次请求开了思考
//     或那个调用是本端点开着思考时发出的，就返回 400，探针第 4 步"不带"推理内容时因此被拒；对所有请求都生效）。
//   - 只作用于不是探针的请求：-404（返回 404）、-400（返回 400）、-hang（不回响应头，等对方断开）、-stall（回了响应头后
//     不发内容）。-400 是 2026-10-26 加的：模型池对 400 不记不可用（§5.4 request），同一个模型可以反复测试连接、每次都
//     到端点；-404 会让模型池记下 not_found，之后没改配置的测试不再发出（md-app-firstrun 的 A20 检查因此用 -400）。
//   - -alwaysthink：不论请求带不带思考参数，每个回复（探针、对话、压缩请求）都先回一段 reasoning_content，像总在思考的
//     模型；回复本来就有思考（think first、thinking check）时不变。探针因此给没勾 Supports thinking 的模型记下推理字段
//     reasoning_content（model-discovery.md §8 的 "This model returned thinking content."）。
//   - -nooff（2026-10-24 补，§7.7、§14.1；对所有请求，探针与否都一样，在认证之后、-replay 之前判断，被拒时叠加的
//     -replay、-404、-hang、-stall 都不起作用）：请求里带明确的
//     "关闭思考"（reasoning.effort 为 "none"、reasoning.enabled 为 false、thinking.type 为 "disabled" 之一；
//     probes.mjs 的 explicitThinkingOff）时回 400，响应体逐字节为 2026-10-24 在 OpenRouter 上录下的原文
//     {"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled.","code":400,
//     "metadata":{"provider_name":null}}}（probes.mjs 的 NOOFF_ERROR_BODY，不换行）；不带思考参数、或带强度时照常回答，
//     并且总带思考内容（同 -alwaysthink，回复本来有思考时不变）。普通地址下 pi 关思考时什么也不发，所以这个后缀只在
//     /openrouter.ai/v1 前缀的地址下（或单元层替身写出那几种写法时）回 400。
//   - -thinklong（2026-10-24 补，§7.7、§14.1；只对探针，第 1–7 步）：开了思考时只流式返回一段超过 256 token 的思考
//     （probes.mjs 的 THINKLONG_THINKING，超过 1100 字，每块 64 字），没有正文和工具调用，以 finish_reason "length"
//     结束（测探针的输出上限规则）；没开思考时照常回答探针。不是探针的请求不受影响。
//
// 认证（只对列表请求与 /chat/completions；列表以外的发现请求不查 key。下面的“key”是 Authorization: Bearer 的值，
// 列表请求没有 Bearer 时取 x-api-key）：
//   - FAKE_REQUIRE_KEY：设置后要求 key 为该值，否则 401。
//   - FAKE_KEYS：逗号分隔的可接受 key（没设时不检查），不在其中为 401。
//   - FAKE_QUOTA_KEYS：其中的 key 的对话请求返回 402，type 与 code 为 insufficient_quota。
//   - FAKE_LIMITED_KEYS：其中的 key 的对话请求返回 429 带 Retry-After（秒）；从这个 key 第一次被限流起 FAKE_LIMIT_MS
//     之后恢复，Retry-After 为剩下的秒数；没设 FAKE_LIMIT_MS 时一直限流，Retry-After 为 60。
//   - 上面两个列表里写 "none" 表示不带 key 的请求（没有 key 的提供商）。
// 其他接口：
//   - GET /version：每种列表形状都回答 {"version": FAKE_SERVER_VERSION}（vLLM 的形状，默认 "0.10.1"）；
//     /api/version 只在 ollama 形状、/props 只在 llamacpp 形状回答，其他形状为 404。
//   - 没有的接口（/info、/v2/models/<id>/config、POST /v1/messages 等）为 404，没有正文。
//
// 发现（docs/specs/model-discovery.md §13.1；形状在 discovery.mjs，字段名的依据是规格 §3.3、§4.1、§4.2，数值都是手写的）：
//   - 列表请求 = GET 路径以 /models 结尾（query 不看，/glm/v1/models 这种前缀照样算）；/api/v1/models 除外：那是 LM Studio
//     的原生接口（§3.3 第 6 步），本端点为 404。顺序：先等 FAKE_LIST_DELAY_MS 毫秒（默认 0；对方中途断开就不再回答，
//     测取消与 15 秒时限）→ 这个形状没有这个列表接口时 404 → 按上面的认证查 key，不认识为 401（测 rejected）→ 回列表。
//   - FAKE_MODELS（逗号分隔，默认 "fake-coder,fake-slow"）决定列表里的 id 与顺序；下面的“第一个”“第二个”按这个顺序；
//     W = FAKE_MAX_MODEL_LEN（默认 131072）；“W/4”等都向下取整。列表体为 {"object":"list","data":[行…]}（另注的除外）。
//   - FAKE_NO_V1_ROOT=1：只有以 /v1/models 结尾的路径回答列表，/models 为 404（测补 /v1：填 http://127.0.0.1:<端口>
//     时 ① /models 404、② /v1/models 成功，建议的 Base URL 为 …/v1）。
//   - FAKE_LIST_SHAPE（默认 vllm；不认识的值启动时报错，退出码 1）。每种后面是读取器（kernel/discoverRead.ts、
//     modelDiscover.ts）应读出的种类与值；没写的 reasoning、image、family、chat 都是没报告（null），没有提示：
//     vllm：行 {id, object:"model", owned_by:"vllm", max_model_len:W}（原来的 owned_by 是 "fake"，只改了这一处）。
//       种类 vllm（§3.3 第 3 步），版本读 /version，档案键照旧（vllm|0.10.1）；窗口 W，输出上限为默认值。
//     sglang：行 {id, object, created, owned_by:"sglang", root:id, parent:null, max_model_len:W}；GET /model_info
//       {is_generation:true, has_image_understanding:false, reasoning_parser:"qwen3", tool_call_parser:"qwen25", …}。
//       种类 sglang，版本读 /version；窗口 W；思考为真；图片明确没有（false）；没有 no_tools。
//     ollama：/v1/models 的行 {id, object, created, owned_by:"library"}（没有窗口）；GET /api/version {version:
//       FAKE_SERVER_VERSION}；GET /api/tags（每个模型 name、details.family "llama"，没有 capabilities）；GET /api/ps
//       （只有第一个模型，context_length 8192）；POST /api/show {"model":<id>}（parameters：第二个有 num_ctx 16384；
//       model_info 的 llama.context_length 为 W；capabilities：第一个 completion、tools、thinking，第二个只有
//       completion，其余 completion、tools；不认识的模型 404）。种类 ollama（第 6 步），版本读 /api/version；
//       第一个窗口 8192、思考为真；第二个窗口 16384、思考明确没有、no_tools；其余窗口 W 带 trained_window
//       （探针第 0 步的 reported 窗口为 null，§7.2）、思考明确没有；图片都明确没有；family 都是 llama；chat 都为真。
//     llamacpp：行 {id, object, created, owned_by:"llamacpp", meta:{n_ctx_train:2W, n_ctx:W}}；GET /props
//       {default_generation_settings:{n_ctx:W}, modalities:{vision:false}, build_info:FAKE_SERVER_VERSION, …}。
//       种类 llamacpp，版本为 build_info（/props 只请求一次）；窗口 W（取 n_ctx，不取 n_ctx_train）；图片明确没有。
//     localai：行只有 {id, object}；GET /.well-known/localai.json {name:"LocalAI", version}；GET <base>/models/capabilities
//       （任何以 /models/capabilities 结尾的路径）{data:[{id, capabilities:["chat","completion","tools"],
//       input_modalities:["text"], output_modalities:["text"], context_size:W}]}；也回答 /version。
//       种类 localai（第 6 步，不再凭 /version 认作 vLLM），版本 null；窗口 W；思考、图片明确没有；chat 为真。
//     tensorrt：行 {id, object, created, owned_by:"tensorrt_llm"}（没有窗口）；也回答 /version。
//       种类 tensorrt，版本 null；窗口与输出上限都是默认值。
//     litellm：行 {id, object, created:1677610602, owned_by:"openai", mode:"chat", max_input_tokens:W,
//       max_output_tokens, supports_reasoning:false, supports_function_calling:false}；第二行的 max_output_tokens 等于 W，
//       其余为 W/16。种类 litellm（第 4 步），版本 null；窗口 W；第二行的输出上限不算报告（默认值），其余为 W/16；
//       chat 为真；LiteLLM 的 false 按没报告（思考没报告、没有 no_tools，§4.1）。
//     newapi：响应头 X-New-Api-Version: v0.9.0，体 {success:true, object:"list", data}；行 {id, object,
//       created:1626777600, owned_by:"custom", supported_endpoint_types:["openai","anthropic"]}。
//       种类 newapi（第 1 步），版本 null；chat 为真；api 仍按地址（§3.4）。
//     anthropic：只有以 /v1/models 结尾的路径有列表（/models 为 404），要求 anthropic-version 请求头（没有时 400，
//       {type:"error", error:{type:"invalid_request_error", …}}；key 不对时 401 为 authentication_error）；体
//       {data, has_more:false, first_id, last_id}（一页给出全部），行 {type:"model", id, display_name, created_at,
//       max_input_tokens:W, max_tokens:W/4, capabilities:{image_input:{supported:true}, thinking:{supported:true}}}。
//       地址带 anthropic 段（例如 http://127.0.0.1:<端口>/anthropic）时：种类 unknown、anthropicShape 为真
//       （Anthropic-compatible server），api 为 anthropic-messages；窗口 W；输出上限 W/4；思考、图片为真。
//       没有 Anthropic 提示时请求不带 anthropic-version，列表为 400 → invalid。
//     rich：DeepSeek 式的行 {id, object, owned_by:"deepseek", context_window:W, max_output_tokens:W/16,
//       input_modalities}；第一行 input_modalities 为 ["text","image"] 并带 effort 对象，其余为 ["text"]、没有 effort。
//       种类 unknown；窗口 W；输出上限 W/16；第一行思考、图片为真；其余思考没报告、图片明确没有。
//     typed：行 {id, object, type}：第二行 type 为 "embedding"，其余为 "llm"。种类 unknown；第二行 chat 为假，其余为真。
//     nolist：所有列表请求都是 404（listError 为 no_list）。
//   - 列表以外的发现请求（版本 /version、/api/version、/props，§3.3 第 6 步，§4.2 的详情）不查 key，也不等
//     FAKE_LIST_DELAY_MS。
// 日志：每个请求一行 "[fake-endpoint] METHOD url"；列表请求与列表以外的发现请求（GET，以及
//   POST /api/show；不论回答什么）各打一行 JSON {"port","path"(不含 query),"key"(Authorization: Bearer 的 key，没有时
//   x-api-key，末 4 位；没有为 null)}，在等 FAKE_LIST_DELAY_MS 之前打；对话请求的 JSON 行没有 path 字段，以此区分。
//   每个对话请求另打一行 JSON
//   {"port","model","key"(key 末 4 位，没有为 null),"roles"(消息角色序列),"status"(-hang 为 null),"probe"}，
//   后面接着 scripts.mjs 的 logFields（agent、kind、task、scenario、k、j、tools、toolChoice、format、calls；
//   不是脚本模式时 scenario 为 null，其余照样算）、"enhance"（enhance.mjs 认出的增强会话的种类 taste、strategy、
//   review，不是增强会话时为 null），最后是 "strictTools"（function.strict 为 true 的工具名）与
//   "reasoning"（请求是否带思考参数：reasoning_effort、reasoning、thinking、enable_thinking 之一），
//   平行 Agent 规格 §7.5 的 A 级只给交接的工具加 strict、关闭思考由它们检查；
//   再后面是 "effort"（2026-10-24 补，§14.1：reasoning_effort ?? reasoning.effort ?? null，请求里的思考强度原值，
//   用来看会话的 Off 实际发的是 minimal、测试连接发的是 medium、-nooff 被拒的请求发的是 none）。
//   启动时一行 "[fake-endpoint] synthetic endpoint on http://127.0.0.1:<端口>/v1 (model "fake-coder", list shape "<形状>")"。
// 工具调用 id："call_fake_<端口>_<进程启动时刻>_<进程内计数>"，并行的请求之间、端点重启前后都不重复。
// 其他环境变量：FAKE_PORT（默认 4319）、FAKE_CHUNK_DELAY_MS（默认 20）、FAKE_FIRST_DELAY_MS（默认 0）、
//   FAKE_ENHANCE_SCRIPT（增强脚本文件，见 enhance.mjs）；发现用的 FAKE_LIST_SHAPE、FAKE_NO_V1_ROOT、FAKE_LIST_DELAY_MS 见上。
// 2026-10-26（负责人走查 M7，规格 §14.1）：探针第 8、9 步删掉，第 8 步的暗号、第 9 步的长输出、-truncate、-nocancel、
//   GET /metrics 与 FAKE_NO_METRICS 随之删掉；/metrics 现在同其他没有的接口一样是 404。

import http from 'node:http';
import { createHash } from 'node:crypto';
import { contentText, isSummaryRequest, planReply, summaryReply } from './replies.mjs';
import { NOOFF_ERROR_BODY, NOOFF_STATUS, noOffRejected, probeReply, probeStep, replayRejected, requestedEffort,
  thinkingOn } from './probes.mjs';
import { logFields, scriptReply, sessionOf, withoutWorkCards } from './scripts.mjs';
import { enhanceKindOf, enhanceReply } from './enhance.mjs';
import { LIST_SHAPES, detailAnswer, isListPath, listAnswer, listServed } from './discovery.mjs';

const env = process.env;
const port = Number(env.FAKE_PORT ?? 4319);
const chunkDelayMs = Number(env.FAKE_CHUNK_DELAY_MS ?? 20);
const firstDelayMs = Number(env.FAKE_FIRST_DELAY_MS ?? 0);
const requiredKey = env.FAKE_REQUIRE_KEY;
const modelId = 'fake-coder';

/** @brief 逗号分隔的环境变量转成列表。 */
const listOf = (value) => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);

/** 环境变量给出的 key 规则与服务信息 */
const config = {
  keys: listOf(env.FAKE_KEYS),
  limited: listOf(env.FAKE_LIMITED_KEYS),
  quota: listOf(env.FAKE_QUOTA_KEYS),
  limitMs: env.FAKE_LIMIT_MS ? Number(env.FAKE_LIMIT_MS) : null,
  version: env.FAKE_SERVER_VERSION ?? '0.10.1',
  maxModelLen: Number(env.FAKE_MAX_MODEL_LEN ?? 131072),
  models: listOf(env.FAKE_MODELS ?? 'fake-coder,fake-slow'),
  /** 列表与详情的形状（discovery.mjs） */
  shape: env.FAKE_LIST_SHAPE || 'vllm',
  /** 只在以 /v1/models 结尾的路径回答列表 */
  noV1Root: env.FAKE_NO_V1_ROOT === '1',
  /** 列表请求等这么久再回 */
  listDelayMs: Number(env.FAKE_LIST_DELAY_MS ?? 0),
};

if (!LIST_SHAPES.includes(config.shape)) {
  console.error(`[fake-endpoint] unknown FAKE_LIST_SHAPE "${config.shape}"; expected one of ${LIST_SHAPES.join(', ')}`);
  process.exit(1);
}

/** 运行中的状态 */
const state = {
  /** 限流的 key → 第一次被限流的时刻 */
  limitedSince: new Map(),
  /** 已触发的 "-once" 关键词：关键词|会话哈希 */
  fired: new Set(),
  /** 已触发的 "-once" 关键词：关键词|最后一条用户消息的哈希（压缩后用） */
  firedTexts: new Set(),
  /** -replay 模型开着思考时发出的工具调用 id */
  reasonedCalls: new Set(),
  /** 下一个工具调用 id 的进程内计数 */
  nextCallId: 1,
};
/** 工具调用 id 的前缀：端口与进程启动时刻，端点重启或多个端点之间也不重复 */
const callIdPrefix = `call_fake_${port}_${Date.now().toString(36)}`;

const SUFFIXES = new Set(['notools', 'nochoice', 'noschema', 'replay', '404', '400', 'hang', 'stall', 'alwaysthink',
  'nooff', 'thinklong']);
const NO_KEY = 'none';
const SLOW_MS = 8000;
const UNLIMITED_RETRY_AFTER_S = 60;
const OVERFLOW_MESSAGE = "This model's maximum context length is 1000 tokens";
const REPLAY_THINKING = 'Synthetic reasoning before answering.';
const ALWAYS_THINKING = 'Synthetic reasoning from a model that always thinks.';
/** -nooff 的模型总在思考：没有思考的回复补上这一段（§14.1，2026-10-24） */
const NOOFF_THINKING = 'Synthetic reasoning from a model whose thinking cannot be turned off.';
const REPLAY_MESSAGE = 'The reasoning_content in the thinking mode must be passed back to the API.';
const MORI_NOTE = '[Mori] The previous model';
const COMPACTED = 'The conversation history before this point was compacted';
const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 16);

/** @brief OpenAI 形状的错误体。 */
function errorBody(message, type, code) {
  return { error: code ? { message, type, code } : { message, type } };
}

/** @brief 以 JSON 回复；body 已是 JSON 文字（字符串）时原样发出（-nooff 的 400 要逐字节照录下的原文）。 */
function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** @brief 请求里的 Bearer key；没有时为 null。 */
function bearer(req) {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  return match ? match[1] : null;
}

/** @brief 模型 ID 的后缀集合（以 "-" 分开的段）。 */
function flagsOf(model) {
  return new Set(String(model ?? '').split('-').filter((part) => SUFFIXES.has(part)));
}

/** @brief 限流：从第一次限流起 FAKE_LIMIT_MS 之后恢复（返回 null）；否则 429 带 Retry-After 秒数。 */
function rateLimit(name) {
  const now = Date.now();
  if (!state.limitedSince.has(name)) state.limitedSince.set(name, now);
  const until = config.limitMs === null ? null : state.limitedSince.get(name) + config.limitMs;
  if (until !== null && now >= until) return null;
  const seconds = until === null ? UNLIMITED_RETRY_AFTER_S : Math.max(1, Math.ceil((until - now) / 1000));
  const body = errorBody('Rate limit reached for requests', 'rate_limit_error', 'rate_limit_exceeded');
  return { status: 429, body, headers: { 'Retry-After': String(seconds) } };
}

/** @brief key 规则：不认识的 key 为 401；对话请求另查额度（402）与限流（429）。通过时为 null。 */
function keyFailure(key, chat) {
  const denied = { status: 401, body: errorBody('Incorrect API key provided', 'invalid_request_error') };
  if (requiredKey && key !== requiredKey) return denied;
  if (config.keys.length > 0 && !config.keys.includes(key)) return denied;
  if (!chat) return null;
  const name = key ?? NO_KEY;
  if (config.quota.includes(name)) {
    const body = errorBody('You exceeded your current quota.', 'insufficient_quota', 'insufficient_quota');
    return { status: 402, body };
  }
  return config.limited.includes(name) ? rateLimit(name) : null;
}

/** @brief 用户消息的文字，去掉 Mori 重做时加在末尾的说明。 */
function userText(message) {
  const text = contentText(message?.content);
  const at = text.indexOf(MORI_NOTE);
  return (at >= 0 ? text.slice(0, at) : text).trim();
}

/** @brief "-once" 关键词在这个会话里是不是第一次；是就记下。 */
function firstTime(messages, keyword) {
  const first = userText(messages.find((m) => m.role === 'user'));
  const convKey = `${keyword}|${hash(first)}`;
  const textKey = `${keyword}|${hash(userText(messages[messages.length - 1]))}`;
  const seen = first.startsWith(COMPACTED) ? state.firedTexts.has(textKey) : state.fired.has(convKey);
  if (seen) return false;
  state.fired.add(convKey);
  state.firedTexts.add(textKey);
  return true;
}

/** @brief 关键词造成的错误（http-NNN、http-NNN-once、overflow-once）；没有时为 null。 */
function keywordFailure(messages) {
  const last = messages[messages.length - 1];
  if (last?.role !== 'user') return null;
  const text = contentText(last.content);
  const http = /http-(\d{3})(-once)?/.exec(text);
  if (http && (!http[2] || firstTime(messages, http[0]))) {
    return { status: Number(http[1]), body: errorBody(`Synthetic HTTP ${http[1]} for testing`, 'synthetic_error') };
  }
  if (text.includes('overflow-once') && firstTime(messages, 'overflow-once')) {
    return { status: 400, body: errorBody(OVERFLOW_MESSAGE, 'invalid_request_error', 'context_length_exceeded') };
  }
  return null;
}

/** 请求里表示思考的参数（pi 的 openai-completions 各种 thinkingFormat 写的顶层字段） */
const REASONING_FIELDS = ['reasoning_effort', 'reasoning', 'thinking', 'enable_thinking'];

/** @brief 请求里 function.strict 为 true 的工具名（平行 Agent 规格 §7.5 A 级只给交接的工具加 strict）。 */
function strictToolNames(body) {
  return (body.tools ?? []).filter((tool) => (tool.function ?? tool).strict === true)
    .map((tool) => (tool.function ?? tool).name);
}

/**
 * @brief 每个对话请求一行 JSON 日志；extra 是 scripts.mjs 的 logFields，接在原有字段后面；
 *        然后是 strictTools 与 reasoning（请求是否带思考参数），最后是 effort（§14.1，2026-10-24：
 *        reasoning_effort ?? reasoning.effort ?? null，请求里的思考强度原值）。
 */
function logRequest(req, body, probe, status, extra) {
  const key = bearer(req);
  const roles = (body.messages ?? []).map((m) => m.role);
  const line = { port: req.socket.localPort, model: body.model ?? null, key: key ? key.slice(-4) : null, roles, status,
    probe, ...extra, strictTools: strictToolNames(body),
    reasoning: REASONING_FIELDS.some((field) => body[field] !== undefined && body[field] !== null),
    effort: requestedEffort(body) };
  console.log(JSON.stringify(line));
}

/** @brief 把字符串切成小段，模拟逐字流式输出。 */
function pieces(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** @brief 一次回复的增量序列：[delta, 发完是否等一个分块间隔]。 */
function deltas(reply) {
  const out = [];
  // thinkingPiece：-thinklong 的长思考用大一些的分块（probes.mjs），其他回复每块 4 个字
  for (const piece of pieces(reply.thinking ?? '', reply.thinkingPiece ?? 4)) {
    out.push([{ reasoning_content: piece }, true]);
  }
  for (const piece of pieces(reply.text, 2)) out.push([{ content: piece }, true]);
  // 多个调用按 OpenAI 的分块格式：每个调用先发带 id 和名字的头，再分段发参数；tool_calls[].index 区分是第几个调用。
  for (const [index, call] of reply.toolCalls.entries()) {
    const head = { index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } };
    out.push([{ tool_calls: [head] }, false]);
    // argsText：脚本模式 malformed 的交接单，原样发出（不是合法 JSON）
    for (const piece of pieces(call.argsText ?? JSON.stringify(call.args), 8)) {
      out.push([{ tool_calls: [{ index, function: { arguments: piece } }] }, true]);
    }
  }
  // textAfter：写在调用之后的正文（"call then write"），每块 40 个字
  for (const piece of pieces(reply.textAfter ?? '', 40)) out.push([{ content: piece }, true]);
  return out;
}

/**
 * @brief 以 SSE 方式发送一次流式回复；对方断开后停止。
 * @param opts { includeUsage, promptTokens, delayMs（第一个分块前等多久）, dropAfterFirst（发出第一段内容后断开） }
 */
async function streamReply(res, reply, opts) {
  const id = `chatcmpl-fake-${Date.now()}`;
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelId };
  const open = () => !res.fakeClosed && !res.destroyed;
  const send = (choice) => open() && res.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
  res.writeHead(200, SSE_HEADERS);
  await sleep(opts.delayMs);
  send({ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null });
  for (const [delta, pause] of deltas(reply)) {
    if (!open()) return;
    send({ index: 0, delta, finish_reason: null });
    if (opts.dropAfterFirst) {
      // 等这一段真正发出去再断开，对方先收到内容、再看到连接中断
      await sleep(Math.max(chunkDelayMs, 50));
      res.destroy();
      return;
    }
    if (pause) await sleep(chunkDelayMs);
  }
  if (!open()) return;
  // finishReason：-thinklong 停在输出上限时为 "length"（§7.7）；没有时按有没有工具调用
  const finish = reply.finishReason ?? (reply.toolCalls.length > 0 ? 'tool_calls' : 'stop');
  send({ index: 0, delta: {}, finish_reason: finish });
  if (opts.includeUsage) {
    const usage = { prompt_tokens: opts.promptTokens, completion_tokens: 20, total_tokens: opts.promptTokens + 20 };
    res.write(`data: ${JSON.stringify({ ...base, choices: [], usage })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

/** @brief 读取并解析请求体 JSON。 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

/** @brief 不是探针的请求按 -404、-400、-hang、-stall 处理；处理了返回 true。 */
function nonProbeSuffix(res, body, flags, log) {
  if (flags.has('404')) {
    log(404);
    sendJson(res, 404, errorBody(`The model \`${body.model}\` does not exist.`, 'NotFoundError', 404));
    return true;
  }
  if (flags.has('400')) {
    log(400);
    sendJson(res, 400, errorBody(`Synthetic bad request for \`${body.model}\`.`, 'invalid_request_error', 400));
    return true;
  }
  if (flags.has('hang')) {
    log(null);
    return true;
  }
  if (flags.has('stall')) {
    log(200);
    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders();
    return true;
  }
  return false;
}

/** @brief 按关键词的计划：先看关键词造成的错误，再按关键词回复；messages 不含只有工作卡的消息。 */
function keywordPlan(body, messages) {
  const failure = keywordFailure(messages);
  if (failure) return { failure };
  const last = messages[messages.length - 1];
  const lastText = last?.role === 'user' ? contentText(last.content) : '';
  return { reply: planReply(messages, body.tools, body), lastText };
}

/**
 * @brief 不是探针的请求的计划：压缩请求回摘要；有 tb-scenario 时按脚本；增强会话有脚本时按增强脚本；其他按关键词。
 *        -replay 开着思考时附思考。
 * @return { failure } 或 { reply, lastText（关键词模式下最后一条用户消息的文字，slow、drop-after-first 用） }
 */
function conversationPlan(body, flags, info) {
  const messages = body.messages ?? [];
  if (isSummaryRequest(messages)) return { reply: summaryReply() };
  const plan = info.scenario !== null ? scriptReply(body, flags, info)
    : enhanceReply(messages, info.scenario) ?? keywordPlan(body, withoutWorkCards(messages));
  if (plan.reply && flags.has('replay') && thinkingOn(body) && !plan.reply.thinking) {
    plan.reply.thinking = REPLAY_THINKING;
  }
  return plan;
}

/** @brief 给回复里的工具调用编 id（进程内计数）；-replay 模型带思考发出的调用记下来。 */
function assignCallIds(reply, flags) {
  for (const call of reply.toolCalls) {
    call.id = `${callIdPrefix}_${state.nextCallId}`;
    state.nextCallId += 1;
    if (reply.thinking && flags.has('replay')) state.reasonedCalls.add(call.id);
  }
}

/** @brief 处理一个对话请求。 */
async function handleChat(req, res) {
  const body = await readJson(req);
  const messages = body.messages ?? [];
  const flags = flagsOf(body.model);
  const step = probeStep(messages);
  const info = sessionOf(messages);
  const enhance = enhanceKindOf(messages, info.scenario);
  const log = (status, calls = []) => logRequest(req, body, step > 0, status,
    { ...logFields(body, info, calls), enhance });
  res.on('close', () => { res.fakeClosed = true; });
  // §14.1（2026-10-24）-nooff：明确的"关闭思考"回 400，响应体逐字节照 OpenRouter 的原文（字符串原样发出）
  const noOff = noOffRejected(body, flags) ? { status: NOOFF_STATUS, body: NOOFF_ERROR_BODY } : null;
  const replay = replayRejected(body, flags, state.reasonedCalls)
    ? { status: 400, body: errorBody(REPLAY_MESSAGE, 'invalid_request_error') } : null;
  const fail = (failure) => {
    log(failure.status);
    sendJson(res, failure.status, failure.body, failure.headers);
  };
  const early = keyFailure(bearer(req), true) ?? noOff ?? replay;
  if (early) return fail(early);
  if (step === 0 && nonProbeSuffix(res, body, flags, log)) return;
  const plan = step > 0 ? { reply: probeReply(step, body, flags) } : conversationPlan(body, flags, info);
  if (plan.failure) return fail(plan.failure);
  const { reply } = plan;
  // -alwaysthink：不论请求带不带思考参数都先回一段思考（探针、对话、压缩请求都一样），已有思考的回复不变；
  // -nooff 同样总在思考（§14.1：不带思考参数、带强度都照常回答并带思考内容）
  if (flags.has('alwaysthink') && !reply.thinking) reply.thinking = ALWAYS_THINKING;
  if (flags.has('nooff') && !reply.thinking) reply.thinking = NOOFF_THINKING;
  const lastText = plan.lastText ?? '';
  assignCallIds(reply, flags);
  const slow = body.model === 'fake-slow' || /\bslow\b/.test(lastText);
  log(200, reply.toolCalls.map((call) => call.name));
  await streamReply(res, reply, {
    includeUsage: Boolean(body.stream_options?.include_usage),
    promptTokens: Math.ceil(JSON.stringify(messages).length / 4),
    delayMs: slow ? SLOW_MS : firstDelayMs + (reply.delayMs ?? 0),
    dropAfterFirst: lastText.includes('drop-after-first'),
  });
}

/** @brief 发现请求的 key：Authorization: Bearer，没有时看 x-api-key（Anthropic 的写法）；都没有为 null。 */
function discoveryKey(req) {
  return bearer(req) ?? req.headers['x-api-key'] ?? null;
}

/** @brief 列表与详情请求一行 JSON 日志：{port, path（不含 query）, key（末 4 位，没有为 null）}。 */
function logDiscovery(req, path) {
  const key = discoveryKey(req);
  console.log(JSON.stringify({ port: req.socket.localPort, path, key: key ? key.slice(-4) : null }));
}

/** @brief 没有这个接口：404，没有正文。 */
function notFound(res) {
  res.writeHead(404);
  res.end();
}

/** @brief 列表请求：先等 FAKE_LIST_DELAY_MS（对方断开就不回），再看接口在不在（404）、key（401），然后按形状回答。 */
async function handleList(req, res, path) {
  res.on('close', () => { res.fakeClosed = true; });
  if (config.listDelayMs > 0) await sleep(config.listDelayMs);
  if (res.fakeClosed) return;
  if (!listServed(path, config)) {
    notFound(res);
    return;
  }
  const answer = listAnswer(req.headers, config, keyFailure(discoveryKey(req), false));
  sendJson(res, answer.status, answer.body, answer.headers);
}

/** @brief 列表以外的发现请求（版本、§3.3 第 6 步、§4.2 的详情）：按形状回答，不查 key；没有这个接口为 404。 */
async function handleDetail(req, res, path) {
  const request = req.method === 'POST' ? await readJson(req) : null;
  const answer = detailAnswer(req.method, path, request, config);
  if (answer) sendJson(res, answer.status, answer.body);
  else notFound(res);
}

/** @brief 一个请求：对话、发现请求（GET 与 Ollama 的 POST /api/show，各打一行 JSON 日志）；其他为 404。 */
async function route(req, res, path) {
  if (req.method === 'POST' && path.endsWith('/chat/completions')) return handleChat(req, res);
  if (req.method !== 'GET' && !(req.method === 'POST' && path === '/api/show')) return notFound(res);
  logDiscovery(req, path);
  if (req.method === 'GET' && isListPath(path)) return handleList(req, res, path);
  return handleDetail(req, res, path);
}

const server = http.createServer(async (req, res) => {
  console.log(`[fake-endpoint] ${req.method} ${req.url}`);
  res.on('error', (error) => console.error('[fake-endpoint] response error', error));
  const path = (req.url ?? '').split('?')[0];
  try {
    await route(req, res, path);
  } catch (error) {
    console.error('[fake-endpoint] error', error);
    if (!res.headersSent) sendJson(res, 400, errorBody(String(error)));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-endpoint] synthetic endpoint on http://127.0.0.1:${port}/v1 (model "${modelId}", `
    + `list shape "${config.shape}")`);
});
