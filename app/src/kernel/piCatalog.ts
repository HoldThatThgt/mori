// pi 自带的模型表（docs/specs/model-discovery.md §4.4，2026-10-26 负责人走查回答 1）：服务没报告窗口、最大输出、是否支持
// 思考时，按服务地址取 pi-ai 内置提供商的模型条目。pi 没有“地址 → 提供商”的查询（它按地址调整请求时看的也是 baseUrl），
// 所以按每个条目自己的 baseUrl 认服务：提供商地址与条目同一个 origin、模型 id 完全相同才对上，从不只按名字。
// 模型表是 pi 安装包里的数据：第一次查时按 origin 建一次索引，之后只查，不发请求、不读文件。发现代码里只有这个文件
// import pi-ai 的运行时（AGENTS.md 第 7 条：pi 的运行时只在 kernel/）；取哪几项的规则在 discoverRead.ts 的 fromCatalog。

import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { CatalogEntry } from './discoverRead';

/** @brief 按 origin 的索引：origin → 模型 id → 条目；同一个 id 有几个三项不同的条目时为 null（不取，§4.4）。 */
type CatalogIndex = Map<string, Map<string, CatalogEntry | null>>;

/** 第一次查时建好；pi 的模型表在进程里不变 */
let index: CatalogIndex | null = null;

/**
 * @brief http(s) 地址的 origin（协议、主机、端口）。
 * @return 不是 http(s) URL 时为 null：pi 里没有地址的条目（Azure），或者配置以外传进来的坏地址
 */
function originOf(url: string): string | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
}

/** @brief 是正整数。 */
function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** @brief 两个条目给的三项相同（提供商名不比）。 */
function sameValues(a: CatalogEntry, b: CatalogEntry): boolean {
  return a.contextWindow === b.contextWindow && a.maxTokens === b.maxTokens && a.reasoning === b.reasoning;
}

/** @brief 记一个条目：同一个 origin、同一个 id 已有条目时，三项相同就留着第一个（pi 列出的顺序），不同就都不取。 */
function remember(built: CatalogIndex, origin: string, id: string, entry: CatalogEntry): void {
  const ids = built.get(origin) ?? new Map<string, CatalogEntry | null>();
  built.set(origin, ids);
  if (!ids.has(id)) {
    ids.set(id, entry);
    return;
  }
  const first = ids.get(id);
  if (first && !sameValues(first, entry)) ids.set(id, null);
}

/** @brief 按 origin 建索引：pi 内置提供商（按 pi 列出的顺序）各自的聊天模型条目；窗口或最大输出不是正整数的不算。 */
function buildIndex(): CatalogIndex {
  const built: CatalogIndex = new Map();
  for (const provider of builtinProviders()) {
    for (const model of provider.getModels()) {
      const origin = originOf(model.baseUrl);
      if (origin === null || !positive(model.contextWindow) || !positive(model.maxTokens)) continue;
      remember(built, origin, model.id, { provider: provider.name, contextWindow: model.contextWindow,
        maxTokens: model.maxTokens, reasoning: model.reasoning === true });
    }
  }
  return built;
}

/**
 * @brief 按服务地址查 pi 的模型表（§4.4）：baseUrl 与条目的 baseUrl 是同一个 origin，并且 modelId 与条目的 id 完全相同
 *        （区分大小写）；路径与 API type 不比（z.ai 的 Anthropic 地址与 pi 的 Z.AI 条目是同一个 origin）。
 * @param baseUrl 提供商的地址（新提供商为整理后的 base，已有提供商为配置里的）
 * @param modelId 模型 id，原样
 * @return 对上的条目；pi 不认得这个 origin、没有这个 id，或这个 origin 下几个条目不一致时为 null
 */
export function catalogEntry(baseUrl: string, modelId: string): CatalogEntry | null {
  const origin = originOf(baseUrl);
  if (origin === null) return null;
  index ??= buildIndex();
  return index.get(origin)?.get(modelId) ?? null;
}
