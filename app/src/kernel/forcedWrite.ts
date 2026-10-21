// 三种写法的请求改写（docs/specs/model-providers.md §7.3 的表；docs/specs/parallel-agents-taskboard.md §7.5、§12.7、§14.4）：
// A 指定调用（tool_choice）并只给指定名字的工具加 strict、换上严格 schema；B 加 json_schema 的结构化输出；
// C 不改请求、从回复里读标签。探针（probes.ts 第 5–7 步）与强制填写交接单（handoffForm.ts）共用。
// 纯函数：不改入参，返回新的请求体或选项。

import type { SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { ApiType } from '../shared/models';

/** @brief 请求体改写函数（onPayload 的第二段）：收到上一段改写后的请求体，返回新的请求体。 */
export type PayloadChange = (payload: unknown) => unknown;

/** @brief pi 的 onPayload（各接口组装完请求体之后、发出之前调用）。 */
export type PayloadHook = NonNullable<SimpleStreamOptions['onPayload']>;

// ---- A：指定调用与严格模式 ----

/**
 * @brief 指定调用的 tool_choice（经 toolChoice 选项），三种接口的写法不同（§7.3 的表）。
 * @param api 接口类型
 * @param name 要指定调用的工具名
 */
export function forcedToolChoice(api: ApiType, name: string): unknown {
  if (api === 'openai-completions') return { type: 'function', function: { name } };
  if (api === 'openai-responses') return { type: 'function', name };
  return { type: 'tool', name };
}

/** @brief 请求体里一个工具定义的名字：openai-completions 在 function.name，另两种在 name。 */
function toolNameOf(api: ApiType, tool: Record<string, unknown>): unknown {
  return api === 'openai-completions' ? (tool.function as { name?: unknown } | undefined)?.name : tool.name;
}

/** @brief 给一个工具定义加 strict，给了 schema 时同时换上它（openai-completions 写在 function 里）。 */
function strictTool(api: ApiType, tool: Record<string, unknown>, schema: object | undefined): Record<string, unknown> {
  if (api === 'openai-completions') {
    const fn = { ...(tool.function as object), ...(schema ? { parameters: schema } : {}), strict: true };
    return { ...tool, function: fn };
  }
  const field = api === 'anthropic-messages' ? 'input_schema' : 'parameters';
  return { ...tool, ...(schema ? { [field]: schema } : {}), strict: true };
}

/**
 * @brief 严格模式（经 onPayload）：只给名字为 name 的工具加 strict，其余工具不动；给了 schema 时把这个工具的参数
 *        schema 换成它（交接单的严格版本，平行 Agent 规格 §7.5）。openai-completions 写 tools[i].function.strict 与
 *        function.parameters，openai-responses 写 tools[i].strict 与 parameters，anthropic-messages 写 tools[i].strict
 *        与 input_schema。没有 tools 时原样返回。
 * @param api 接口类型
 * @param payload pi 组装好的请求体
 * @param name 要加 strict 的工具名（探针第 5 步为 submit_outcome）
 * @param schema 换上的参数 schema；省略时不换
 * @return 新的请求体（不改入参）
 */
export function withStrictTools(api: ApiType, payload: unknown, name: string, schema?: object): unknown {
  const body = payload as { tools?: Record<string, unknown>[] };
  if (!Array.isArray(body.tools)) return payload;
  const tools = body.tools.map((tool) => (toolNameOf(api, tool) === name ? strictTool(api, tool, schema) : tool));
  return { ...body, tools };
}

// ---- B：结构化输出 ----

/**
 * @brief 严格的 JSON schema 输出（经 onPayload）：openai-completions 写 response_format，openai-responses 写
 *        text.format（保留 text 的其他选项）；anthropic-messages 没有这种写法，不用 B（探针不跑第 6 步）。
 * @param api 接口类型
 * @param payload pi 组装好的请求体
 * @param name schema 的名字
 * @param schema 输出要符合的 JSON schema（严格版本）
 * @return 新的请求体（不改入参）
 */
export function withJsonSchema(api: ApiType, payload: unknown, name: string, schema: object): unknown {
  const body = payload as Record<string, unknown>;
  const copy = { ...schema };
  if (api === 'openai-completions') {
    return { ...body, response_format: { type: 'json_schema', json_schema: { name, schema: copy, strict: true } } };
  }
  const text = (body.text ?? {}) as Record<string, unknown>;
  const format = { type: 'json_schema', name, schema: copy, strict: true };
  return { ...body, text: { ...text, format } };
}

/**
 * @brief 把改写接在已有的 onPayload 之后（平行 Agent 规格 §14.4、§14.6 T-F1）：先调原来的（pi 的
 *        before_provider_request），它返回 undefined 时沿用原请求体，再按 change 改。
 * @param original 选项里原来的 onPayload；没有时省略
 * @param change 这次的改写
 */
export function chainPayload(original: PayloadHook | undefined, change: PayloadChange): PayloadHook {
  return async (payload, model) => {
    const first = original ? await original(payload, model) : undefined;
    return change(first === undefined ? payload : first);
  };
}

// ---- C：标签 ----

/**
 * @brief C 级回答里一个标签的内容：第一个 <name>…</name> 之间的文字，去掉首尾空白。
 * @param text 回复正文
 * @param name 标签名
 * @return 内容；没有这个标签（或没有闭合）时为 null
 */
export function tagContent(text: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return match ? match[1].trim() : null;
}

/**
 * @brief 探针第 7 步的一次回答：能解析出 <summary>…</summary><outcome>…</outcome>，summary 不为空，
 *        outcome 在取值列表内。
 * @param text 回复正文
 * @param values outcome 的取值列表（探针为 ok、fail）
 */
export function parseTagged(text: string, values: readonly string[]): boolean {
  const match = /<summary>([\s\S]+?)<\/summary>\s*<outcome>\s*([^<]*?)\s*<\/outcome>/.exec(text);
  return !!match && match[1].trim() !== '' && values.includes(match[2]);
}
