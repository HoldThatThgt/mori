// 合成测试端点（synthetic）的发现部分：FAKE_LIST_SHAPE 各个形状的模型列表与详情接口，只用于测试，不是真实服务。
// 依据：docs/specs/model-discovery.md §13.1“合成端点的行为”；字段名取自规格 §3.3、§4.1、§4.2 的表（调研时核对过的源码与
// 文档，见 docs/proposals/model-discovery.md §7），数值都是手写的。每个形状的字段与读取器应读出的值逐条列在 server.mjs 开头。
// 这里只给出回答的内容；等待、查 key、日志与路由在 server.mjs。

/** FAKE_LIST_SHAPE 的取值（默认 vllm） */
export const LIST_SHAPES = Object.freeze(['vllm', 'sglang', 'ollama', 'llamacpp', 'localai', 'tensorrt', 'litellm',
  'newapi', 'anthropic', 'rich', 'typed', 'nolist']);

/** 列表行的 created（手写，不等于 LiteLLM、One API 的固定值，§3.3 第 4、5 步） */
const SYNTHETIC_CREATED = 1760000000;
/** LiteLLM 列表行固定的 created（§3.3 第 4 步） */
const LITELLM_CREATED = 1677610602;
/** One API / New API 列表行的 created（§3.3 第 5 步；New API 在第 1 步就认出，这个值不影响） */
const ONEAPI_CREATED = 1626777600;
/** New API 的响应头 X-New-Api-Version 的值（手写） */
const NEW_API_VERSION = 'v0.9.0';
/** Ollama：/api/ps 里第一个模型的当前窗口、/api/show 里第二个模型 Modelfile 的 num_ctx（§13.1） */
const OLLAMA_PS_WINDOW = 8192;
const OLLAMA_NUM_CTX = 16384;
/** Ollama 的 details（/api/tags、/api/ps、/api/show 共用；family 进 §4.1 的 details.family） */
const OLLAMA_DETAILS = Object.freeze({ parent_model: '', format: 'gguf', family: 'llama', families: ['llama'],
  parameter_size: '8.0B', quantization_level: 'Q4_K_M' });
const OLLAMA_MODIFIED = '2026-10-01T08:00:00.000Z';
/** Anthropic 形状要求的请求头（§3.2 ① 带 anthropic-version） */
const ANTHROPIC_VERSION_HEADER = 'anthropic-version';
/** LM Studio 的原生接口（§3.3 第 6 步）：不算列表请求，本端点为 404 */
const LMSTUDIO_PATH = '/api/v1/models';

/** @brief 列表请求的路径：GET 路径以 /models 结尾，LM Studio 的原生接口除外。 */
export function isListPath(path) {
  return path.endsWith('/models') && path !== LMSTUDIO_PATH;
}

/**
 * @brief 这个列表路径有没有接口：nolist 都没有；FAKE_NO_V1_ROOT=1 与 anthropic 形状只有以 /v1/models 结尾的路径。
 * @param env { shape, noV1Root }
 */
export function listServed(path, env) {
  if (env.shape === 'nolist') return false;
  if (env.noV1Root || env.shape === 'anthropic') return path.endsWith('/v1/models');
  return true;
}

/** @brief LiteLLM 的行：mode、max_input_tokens、max_output_tokens（第二行的输出等于窗口），以及填成 false 的能力。 */
function litellmRow(id, index, env) {
  const output = index === 1 ? env.maxModelLen : Math.floor(env.maxModelLen / 16);
  // LiteLLM 把不知道的能力填成 false（§4.1）：读取器按没报告
  return { id, object: 'model', created: LITELLM_CREATED, owned_by: 'openai', mode: 'chat',
    max_input_tokens: env.maxModelLen, max_output_tokens: output, supports_reasoning: false,
    supports_function_calling: false };
}

/** @brief Anthropic 形状的行：max_input_tokens、max_tokens（窗口的四分之一）、capabilities 里的图片与思考。 */
function anthropicRow(id, _index, env) {
  return { type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z', max_input_tokens: env.maxModelLen,
    max_tokens: Math.floor(env.maxModelLen / 4),
    capabilities: { image_input: { supported: true }, thinking: { supported: true } } };
}

/** @brief DeepSeek 式的行：第一行带图片与 effort，其余只有文字、没有 effort。 */
function richRow(id, index, env) {
  const row = { id, object: 'model', owned_by: 'deepseek', context_window: env.maxModelLen,
    max_output_tokens: Math.floor(env.maxModelLen / 16), input_modalities: index === 0 ? ['text', 'image'] : ['text'] };
  if (index === 0) row.effort = { supported: ['low', 'medium', 'high'] };
  return row;
}

/** @brief 各形状的列表行：id 与 index 来自 FAKE_MODELS 的顺序，env.maxModelLen 是窗口。 */
const ROWS = {
  vllm: (id, _index, env) => ({ id, object: 'model', owned_by: 'vllm', max_model_len: env.maxModelLen }),
  sglang: (id, _index, env) => ({ id, object: 'model', created: SYNTHETIC_CREATED, owned_by: 'sglang', root: id,
    parent: null, max_model_len: env.maxModelLen }),
  ollama: (id) => ({ id, object: 'model', created: SYNTHETIC_CREATED, owned_by: 'library' }),
  llamacpp: (id, _index, env) => ({ id, object: 'model', created: SYNTHETIC_CREATED, owned_by: 'llamacpp',
    meta: { n_ctx_train: env.maxModelLen * 2, n_ctx: env.maxModelLen } }),
  localai: (id) => ({ id, object: 'model' }),
  tensorrt: (id) => ({ id, object: 'model', created: SYNTHETIC_CREATED, owned_by: 'tensorrt_llm' }),
  litellm: litellmRow,
  newapi: (id) => ({ id, object: 'model', created: ONEAPI_CREATED, owned_by: 'custom',
    supported_endpoint_types: ['openai', 'anthropic'] }),
  anthropic: anthropicRow,
  rich: richRow,
  typed: (id, index) => ({ id, object: 'model', type: index === 1 ? 'embedding' : 'llm' }),
};

/** @brief Anthropic 形状的错误体。 */
function anthropicError(type, message) {
  return { type: 'error', error: { type, message } };
}

/** @brief 列表的响应体与响应头（已过了路径与 key 的检查）。 */
function listBody(env) {
  const data = env.models.map((id, index) => ROWS[env.shape](id, index, env));
  if (env.shape === 'anthropic') {
    return { body: { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null },
      headers: {} };
  }
  if (env.shape === 'newapi') {
    return { body: { success: true, object: 'list', data }, headers: { 'X-New-Api-Version': NEW_API_VERSION } };
  }
  return { body: { object: 'list', data }, headers: {} };
}

/**
 * @brief 列表请求的回答（路径已确认有接口）。
 * @param headers 请求头（anthropic 形状要 anthropic-version）
 * @param env { shape, models, maxModelLen }
 * @param denied server.mjs 的 key 检查结果（{ status: 401, body }），通过时为 null
 * @return { status, body, headers }
 */
export function listAnswer(headers, env, denied) {
  const anthropic = env.shape === 'anthropic';
  if (denied) {
    return anthropic ? { status: 401, body: anthropicError('authentication_error', 'invalid x-api-key'), headers: {} }
      : { ...denied, headers: {} };
  }
  if (anthropic && !headers[ANTHROPIC_VERSION_HEADER]) {
    const body = anthropicError('invalid_request_error', 'anthropic-version: header is required');
    return { status: 400, body, headers: {} };
  }
  return { status: 200, ...listBody(env) };
}

/** @brief Ollama 第 index 个模型的 capabilities：第一个含 tools 与 thinking，第二个没有 tools，其余含 tools。 */
function ollamaCapabilities(index) {
  if (index === 0) return ['completion', 'tools', 'thinking'];
  return index === 1 ? ['completion'] : ['completion', 'tools'];
}

/** @brief Ollama 的 /api/tags：每个模型一项，没有 capabilities（§4.2 这时用 /api/show 的）。 */
function ollamaTags(env) {
  return { models: env.models.map((id) => ({ name: id, model: id, modified_at: OLLAMA_MODIFIED, size: 4920753328,
    digest: `sha256:synthetic-${id}`, details: OLLAMA_DETAILS })) };
}

/** @brief Ollama 的 /api/ps：只有第一个模型已加载，context_length 为 OLLAMA_PS_WINDOW。 */
function ollamaPs(env) {
  return { models: env.models.slice(0, 1).map((id) => ({ name: id, model: id, size: 6654289920,
    digest: `sha256:synthetic-${id}`, details: OLLAMA_DETAILS, expires_at: '2026-10-23T12:00:00.000Z',
    size_vram: 6654289920, context_length: OLLAMA_PS_WINDOW })) };
}

/**
 * @brief Ollama 的 POST /api/show（{ "model": <id> }，§4.2）：第二个模型的 parameters 有 num_ctx；
 *        每个模型的 model_info 有训练窗口 llama.context_length = 窗口；不认识的模型为 404。
 */
function ollamaShow(request, env) {
  const id = request?.model;
  const index = env.models.indexOf(id);
  if (index < 0) return { status: 404, body: { error: `model '${id}' not found` } };
  const stop = 'stop                           "<|eot_id|>"';
  const parameters = index === 1 ? `num_ctx                        ${OLLAMA_NUM_CTX}\n${stop}` : stop;
  return { status: 200, body: { license: '', modelfile: '# Modelfile (synthetic)', parameters,
    template: '{{ .Prompt }}', details: OLLAMA_DETAILS,
    model_info: { 'general.architecture': 'llama', 'llama.context_length': env.maxModelLen },
    capabilities: ollamaCapabilities(index), modified_at: OLLAMA_MODIFIED } };
}

/** @brief SGLang 的 /model_info：配了思考解析器与工具解析器，不理解图片，是生成模型。 */
function sglangModelInfo() {
  return { model_path: 'synthetic/fake-model', tokenizer_path: 'synthetic/fake-model', is_generation: true,
    preferred_sampling_params: null, weight_version: 'default', has_image_understanding: false,
    has_audio_understanding: false, model_type: 'qwen3', architectures: ['Qwen3ForCausalLM'],
    reasoning_parser: 'qwen3', tool_call_parser: 'qwen25' };
}

/** @brief llama.cpp 的 /props：n_ctx 为窗口，不支持图片，build_info 为 FAKE_SERVER_VERSION。 */
function llamacppProps(env) {
  return { default_generation_settings: { n_ctx: env.maxModelLen, params: { temperature: 0.8 } }, total_slots: 1,
    model_path: 'models/synthetic.gguf', chat_template: '{{ messages }}', modalities: { vision: false, audio: false },
    build_info: env.version };
}

/** @brief LocalAI 的 <base>/models/capabilities：每个模型能聊天、能调工具，只收文字，context_size 为窗口。 */
function localaiCapabilities(env) {
  return { object: 'list', data: env.models.map((id) => ({ id, capabilities: ['chat', 'completion', 'tools'],
    input_modalities: ['text'], output_modalities: ['text'], context_size: env.maxModelLen })) };
}

/** @brief 各形状只在自己那里回答的 GET 接口（路径 → 响应体）；/version 每个形状都回答（见 detailAnswer）。 */
const SHAPE_GETS = {
  sglang: { '/model_info': sglangModelInfo },
  ollama: { '/api/version': (env) => ({ version: env.version }), '/api/tags': ollamaTags, '/api/ps': ollamaPs },
  llamacpp: { '/props': llamacppProps },
  localai: { '/.well-known/localai.json': (env) => ({ name: 'LocalAI', version: env.version }) },
};

/**
 * @brief 列表以外的发现请求（版本、§3.3 第 6 步、§4.2 的详情）的回答；不查 key。
 * @param method GET，或 POST（只有 Ollama 的 /api/show）
 * @param path 请求路径（不含 query）
 * @param request POST 的 JSON 正文；GET 时为 null
 * @param env { shape, models, maxModelLen, version }
 * @return { status, body }；这个形状没有这个接口时为 null（404）
 */
export function detailAnswer(method, path, request, env) {
  if (method === 'POST') return path === '/api/show' && env.shape === 'ollama' ? ollamaShow(request, env) : null;
  if (path === '/version') return { status: 200, body: { version: env.version } };
  if (env.shape === 'localai' && path.endsWith('/models/capabilities')) {
    return { status: 200, body: localaiCapabilities(env) };
  }
  const answer = SHAPE_GETS[env.shape]?.[path];
  return answer ? { status: 200, body: answer(env) } : null;
}
