// 读写 pi 自己的 models.json（Mori 的连接和模型）与 pi 设置里的默认模型、每个模型新会话默认的思考强度，
// 并通过 pi 的 ModelRuntime 测试连接（docs/v0/screens/settings.md "连接与模型"）。
// Mori 的连接是 models.json 里 id 为 mori-endpoint、mori-endpoint-<N> 的 provider（按文件里的顺序），其他 provider 不列出、不改动。
// API key 不写进 models.json：由主进程按 provider id 加密保存，pi 只在内存里持有（runtime API key）。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import {
  API_TYPES, COMPAT_OPTIONS, THINKING_LEVELS, type AvailableModel, type ConfigInfo, type ConnectionInfo,
  type Connection, type ConnectionSaveResult, type Endpoint, type ModelForm, type ModelInfo, type SaveResult,
  type SavedConnection, type TestResult, type ThinkingLevel,
} from '../shared/protocol';
import { requestStoreKey } from './credentials';
import { getRuntime, globalSettings } from './pi';

/** Mori 第一个连接的 provider id（M0 起沿用）；之后的连接是 mori-endpoint-<毫秒时间戳>，见 nextProviderId */
const PROVIDER_ID = 'mori-endpoint';
/** Mori 的 provider id */
const MORI_PROVIDER = /^mori-endpoint(?:-\d+)?$/;
/** models.json 的模型没写 contextWindow 时 pi 用的值（provider-composer.js modelFromJson） */
const DEFAULT_CONTEXT_WINDOW = 128_000;
/** 设置里没有按模型的、也没有全局的思考强度时 pi 用的值（core/defaults.js DEFAULT_THINKING_LEVEL） */
const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';

/** 测试连接的上限，见 docs/v0/defaults.md */
const TEST_TIMEOUT_MS = 30_000;
const TEST_MAX_TOKENS = 512;

/** 正在进行的测试连接；你点"Cancel"时中止它 */
let runningTest: AbortController | null = null;
/**
 * 改 models.json 和默认模型的命令排成的队（后台进程同时处理多条命令）：保存连接要在读和写之间等主进程存 key，
 * 两次保存交错时后写的会盖掉先写的改动，还会争用同一个临时文件。
 */
let editQueue: Promise<unknown> = Promise.resolve();

/** 字符串字面量或 // 行注释；照搬 pi 1.3.0 stripJsonComments（dist/utils/json.js）的第一个正则 */
const LINE_COMMENT = /"(?:\\.|[^"\\])*"|\/\/[^\n]*/g;
/** 字符串字面量或 } ] 前多余的逗号；同上的第二个正则 */
const TRAILING_COMMA = /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g;

type JsonObject = Record<string, unknown>;
type ModelsFile = JsonObject & { providers?: Record<string, JsonObject> };

/** @brief 读到的 models.json。 */
interface ModelsText {
  /** 解析结果；文件不存在时为空对象 */
  file: ModelsFile;
  /** 文件里有 // 注释（Mori 重新写出整个文件时会丢掉） */
  commented: boolean;
}
/** pi 的聊天模型（ModelRuntime.getModel 的结果） */
type PiModel = NonNullable<ReturnType<ModelRuntime['getModel']>>;

/** @brief 决定可选思考强度的模型字段（models.json 的模型条目和 pi 的 Model 都有）。 */
interface ThinkingCapability {
  /** 标了支持思考 */
  reasoning?: unknown;
  /** 思考强度到端点取值的映射；某一档为 null 表示不支持 */
  thinkingLevelMap?: unknown;
}

/**
 * @brief 模型可选的思考强度。照搬 pi-ai 1.3.0 的 getSupportedThinkingLevels（dist/models.js 679–691）：
 *        pi-coding-agent 没有导出它，pi-ai 也不是 Mori 的直接依赖。
 */
function supportedThinkingLevels(model: ThinkingCapability): ThinkingLevel[] {
  if (!model.reasoning) return ['off'];
  const map = (model.thinkingLevelMap ?? {}) as Partial<Record<ThinkingLevel, unknown>>;
  return THINKING_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

/** @brief 把思考强度收紧到模型支持的一档：先往高找，再往低找。照搬 pi-ai 1.3.0 的 clampThinkingLevel（同上 692–710）。 */
function clampThinkingLevel(model: ThinkingCapability, level: ThinkingLevel): ThinkingLevel {
  const available = supportedThinkingLevels(model);
  if (available.includes(level)) return level;
  const requested = THINKING_LEVELS.indexOf(level);
  if (requested < 0) return available[0] ?? 'off';
  const higher = THINKING_LEVELS.slice(requested).find((candidate) => available.includes(candidate));
  const lower = THINKING_LEVELS.slice(0, requested).reverse().find((candidate) => available.includes(candidate));
  return higher ?? lower ?? available[0] ?? 'off';
}

/** @brief models.json 的位置。 */
function modelsPath(agentDir: string): string {
  return join(agentDir, 'models.json');
}

/** @brief 去掉 // 行注释，字符串里的不动（pi 1.3.0 stripJsonComments 的前一半）。 */
function stripLineComments(text: string): string {
  return text.replace(LINE_COMMENT, (match) => (match[0] === '"' ? match : ''));
}

/** @brief 去掉 } ] 前多余的逗号，字符串里的不动（pi 1.3.0 stripJsonComments 的后一半）。 */
function stripTrailingCommas(text: string): string {
  return text.replace(TRAILING_COMMA, (match, tail?: string) => tail ?? (match[0] === '"' ? match : ''));
}

/**
 * @brief 读取 models.json，和 pi 一样去掉 BOM、// 注释和多余的逗号再解析（core/model-config.js ModelConfig.load：
 *        pi 读得了的文件这里也读得了）；文件不存在时返回空对象，无法解析时报错且不改动文件。
 */
async function readModelsFile(path: string): Promise<ModelsText> {
  let text: string;
  try {
    text = (await readFile(path, 'utf8')).replace(/^﻿/, '');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file: {}, commented: false };
    throw error;
  }
  const uncommented = stripLineComments(text);
  try {
    return { file: JSON.parse(stripTrailingCommas(uncommented)) as ModelsFile, commented: uncommented !== text };
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${(error as Error).message}`);
  }
}

/** @brief 要改写时读取 models.json：有 // 注释时拒绝并记录（Mori 重新写出整个文件，注释会丢掉）。多余的逗号不影响。 */
async function readModelsForEdit(path: string): Promise<ModelsFile> {
  const { file, commented } = await readModelsFile(path);
  if (!commented) return file;
  const message = `${path} contains // comments that saving would remove; remove them or edit the file by hand`;
  console.error(`[kernel] ${message}`);
  throw new Error(message);
}

/** @brief 改 models.json 和默认模型的命令排队执行：等前一个做完（成功或失败）再做这一个。 */
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const next = editQueue.then(task, task);
  editQueue = next.catch(() => undefined);
  return next;
}

/** @brief 先写临时文件再改名，避免写到一半留下损坏的 models.json。 */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

/** @brief models.json 里 Mori 的 provider id，按文件里的顺序。 */
function moriProviderIds(file: ModelsFile): string[] {
  return Object.keys(file.providers ?? {}).filter((id) => MORI_PROVIDER.test(id));
}

/**
 * @brief 新连接的 provider id，删掉的 id 不再用：pi 按 provider id 找 key 和模型，会话文件记的是 provider/模型，
 *        重用会让打开着的和关掉的会话悄悄连到新的端点。models.json 里还没有 Mori 的连接时用 mori-endpoint，
 *        否则用 mori-endpoint-<毫秒时间戳>（已被占用时加一）。
 */
function nextProviderId(file: ModelsFile): string {
  if (moriProviderIds(file).length === 0) return PROVIDER_ID;
  const used = new Set(Object.keys(file.providers ?? {}));
  let n = Date.now();
  while (used.has(`${PROVIDER_ID}-${n}`)) n += 1;
  return `${PROVIDER_ID}-${n}`;
}

/** @brief 取出 Mori 的一个 provider；不存在或不是 Mori 的时报错。 */
function requireProvider(file: ModelsFile, providerId: string): JsonObject {
  const provider = MORI_PROVIDER.test(providerId) ? file.providers?.[providerId] : undefined;
  if (!provider) throw new Error(`Connection ${providerId} not found in models.json`);
  return provider;
}

/** @brief provider 下的模型条目，按文件里的顺序。 */
function modelsOf(provider: JsonObject | undefined): JsonObject[] {
  return Array.isArray(provider?.models) ? (provider.models as JsonObject[]) : [];
}

/** @brief pi 内存里是否有这个 provider 的 key。 */
function hasKey(runtime: ModelRuntime, providerId: string): boolean {
  return runtime.getProviderAuthStatus(providerId).source === 'runtime';
}

/** @brief 连接本身；key 不回传，apiKey 总是空串。 */
function describeEndpoint(providerId: string, provider: JsonObject): Endpoint {
  const api = API_TYPES.find((type) => type === provider.api) ?? 'openai-completions';
  const compat = (provider.compat ?? {}) as JsonObject;
  return {
    name: String(provider.name ?? providerId),
    baseUrl: String(provider.baseUrl ?? ''),
    api,
    apiKey: '',
    compat: COMPAT_OPTIONS.filter((option) => compat[option.field] === option.value).map((option) => option.id),
  };
}

/**
 * @brief 一个模型。新会话默认的思考强度是 pi 新建会话时会用的那个（sdk.js 120–144）：
 *        modelThinkingLevels["provider/模型"] → defaultThinkingLevel → medium，再按模型收紧。
 */
function describeModel(providerId: string, model: JsonObject, settings: SettingsManager): ModelInfo {
  const id = String(model.id ?? '');
  const level = settings.getModelThinkingLevel(providerId, id) ?? settings.getDefaultThinkingLevel()
    ?? DEFAULT_THINKING_LEVEL;
  return {
    id,
    contextWindow: Number(model.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
    reasoning: model.reasoning === true,
    thinkingLevel: clampThinkingLevel(model, level),
    thinkingLevels: supportedThinkingLevels(model),
  };
}

/** @brief Mori 的全部连接和它们下面的模型。 */
function describeConnections(file: ModelsFile, runtime: ModelRuntime, settings: SettingsManager): ConnectionInfo[] {
  return moriProviderIds(file).map((providerId) => {
    const provider = file.providers?.[providerId] ?? {};
    return {
      providerId,
      endpoint: describeEndpoint(providerId, provider),
      keySaved: hasKey(runtime, providerId),
      models: modelsOf(provider).map((model) => describeModel(providerId, model, settings)),
    };
  });
}

/** @brief 首次启动的表单：第一个有模型的连接和它的第一个模型；一个模型都没有时为 null（按首次启动处理）。 */
function firstSaved(connections: ConnectionInfo[]): SavedConnection | null {
  const first = connections.find((connection) => connection.models.length > 0);
  if (!first) return null;
  const { id, contextWindow, reasoning, thinkingLevel } = first.models[0];
  return { keySaved: first.keySaved,
    connection: { ...first.endpoint, modelId: id, contextWindow, reasoning, thinkingLevel } };
}

/** @brief 顶栏模型菜单：pi 现在能用的全部模型（有 key 的）；Mori 的连接带连接名，其他 provider 用 id。 */
function availableModels(file: ModelsFile, runtime: ModelRuntime): AvailableModel[] {
  return runtime.getAvailableSnapshot().map((model) => {
    const provider = MORI_PROVIDER.test(model.provider) ? file.providers?.[model.provider] : undefined;
    return { ref: `${model.provider}/${model.id}`, provider: model.provider, id: model.id,
      providerName: String(provider?.name ?? model.provider) };
  });
}

/** @brief pi 读设置文件时报告的错误（带文件路径），有时记录；没有时为 null。 */
function settingsLoadError(settings: SettingsManager): string | null {
  const errors = settings.drainErrors().map((item) => `${item.path ?? item.scope}: ${item.error.message}`);
  if (errors.length === 0) return null;
  console.error(`[kernel] cannot read pi settings: ${errors.join('; ')}`);
  return errors.join('; ');
}

/**
 * @brief 设置页、首次启动和顶栏模型菜单要的配置：连接和模型、默认模型、pi 能用的模型，
 *        以及 pi 读 models.json 和 settings.json 的错误。
 */
export function readConfig(agentDir: string): Promise<ConfigInfo> {
  // pi 只在 refresh 时读 models.json：每次读取前先让它重读，你手工修好了文件或加了 provider，重新打开设置页就看得到
  // （排在写入后面，不与保存交错）。
  return serialize(async () => {
    const runtime = await getRuntime();
    await runtime.refresh({ allowNetwork: false });
    return describeConfig(agentDir, runtime);
  });
}

/** @brief config.get 的内容：pi 已经读过的 models.json、设置和它们的错误。 */
async function describeConfig(agentDir: string, runtime: ModelRuntime): Promise<ConfigInfo> {
  const { file } = await readModelsFile(modelsPath(agentDir));
  const settings = await globalSettings();
  const settingsError = settingsLoadError(settings);
  const connections = describeConnections(file, runtime, settings);
  const provider = settings.getDefaultProvider();
  const model = settings.getDefaultModel();
  return {
    agentDir,
    saved: firstSaved(connections),
    connections,
    defaultModel: provider && model ? `${provider}/${model}` : null,
    models: availableModels(file, runtime),
    modelsError: runtime.getError() ?? null,
    settingsError,
    defaultThinkingLevel: (settings.getDefaultThinkingLevel() as ThinkingLevel | undefined) ?? DEFAULT_THINKING_LEVEL,
  };
}

/** @brief 按勾选的兼容选项改写 compat：勾选的写入，没勾选的删除，其他手写字段保留。只对 openai-completions 生效。 */
function mergeCompat(previous: unknown, endpoint: Endpoint): JsonObject | undefined {
  const compat: JsonObject = { ...(previous as JsonObject | undefined) };
  if (endpoint.api !== 'openai-completions') return Object.keys(compat).length ? compat : undefined;
  for (const option of COMPAT_OPTIONS) {
    if (endpoint.compat.includes(option.id)) compat[option.field] = option.value;
    else delete compat[option.field];
  }
  return Object.keys(compat).length ? compat : undefined;
}

/** @brief 把连接本身合并进 provider：保留手写的 headers 等字段和模型，去掉 apiKey 字段。 */
function mergeEndpoint(provider: JsonObject, endpoint: Endpoint): JsonObject {
  const { apiKey: _droppedKey, ...previous } = provider;
  return { ...previous, name: endpoint.name, baseUrl: endpoint.baseUrl, api: endpoint.api,
    compat: mergeCompat(previous.compat, endpoint) };
}

/** @brief 写入（或更新）provider 下的一个模型：保留手写的字段和位置；name 没有时取 ID；不支持思考时去掉 reasoning。 */
function upsertModel(provider: JsonObject, form: ModelForm): JsonObject {
  const models = modelsOf(provider);
  const previous = models.find((model) => model.id === form.modelId);
  const model: JsonObject = { ...previous, id: form.modelId, name: previous?.name ?? form.modelId,
    contextWindow: form.contextWindow, reasoning: form.reasoning || undefined };
  const next = previous ? models.map((item) => (item === previous ? model : item)) : [...models, model];
  return { ...provider, models: next };
}

/** @brief 没填 key 时只允许沿用已保存的 key，而且服务地址的 origin 不能变；所以新连接一定要填 key。 */
function requireReusableKey(runtime: ModelRuntime, providerId: string, previousBaseUrl: unknown,
  baseUrl: string): void {
  const previousOrigin = previousBaseUrl ? new URL(String(previousBaseUrl)).origin : null;
  if (!hasKey(runtime, providerId) || previousOrigin !== new URL(baseUrl).origin) {
    throw new Error('API key is required when the base URL changes');
  }
}

/** @brief pi 内存里这个 provider 的 key（runtime API key）；没有时为 null，读不出时记录并返回 null。 */
async function runtimeKey(runtime: ModelRuntime, providerId: string): Promise<string | null> {
  if (!hasKey(runtime, providerId)) return null;
  try {
    const key = (await runtime.getAuth(providerId))?.auth.apiKey;
    if (key) return key;
    console.error(`[kernel] pi returned no key for ${providerId}`);
  } catch (error) {
    console.error(`[kernel] cannot read the key of ${providerId}: ${(error as Error).message}`);
  }
  return null;
}

/**
 * @brief 写 models.json 失败后撤回刚加密保存的新 key，免得重启后它和旧的服务地址配在一起：恢复成 pi 内存里原来的 key
 *        （启动时从 credentials.json 读入；这时新 key 还没放进 pi 的内存）；原来没有（新连接）或读不出时删掉。
 *        撤回失败只记录，不盖过写 models.json 的错误。
 */
async function restoreKey(runtime: ModelRuntime, providerId: string): Promise<void> {
  try {
    const previous = await runtimeKey(runtime, providerId);
    await requestStoreKey(providerId, previous);
    if (!previous) console.error(`[kernel] deleted the new key of ${providerId}; no previous key to restore`);
  } catch (error) {
    console.error(`[kernel] cannot restore the key of ${providerId}: ${(error as Error).message}`);
  }
}

/**
 * @brief 写入一个 provider 并交给 pi：填了 key 时先请主进程加密保存（失败就不写），没填时只能沿用已保存的 key；
 *        写 models.json 后 pi 重读，再把新 key 放进 pi 的内存。写 models.json 失败时撤回新 key（restoreKey）再报错。
 */
async function writeProvider(path: string, file: ModelsFile, providerId: string, provider: JsonObject,
  endpoint: Endpoint): Promise<ModelRuntime> {
  const runtime = await getRuntime();
  if (endpoint.apiKey) await requestStoreKey(providerId, endpoint.apiKey);
  else requireReusableKey(runtime, providerId, file.providers?.[providerId]?.baseUrl, endpoint.baseUrl);
  file.providers = { ...file.providers, [providerId]: provider };
  try {
    await writeJsonAtomic(path, file);
  } catch (error) {
    console.error(`[kernel] cannot write ${path}: ${(error as Error).message}`);
    if (endpoint.apiKey) await restoreKey(runtime, providerId);
    throw error;
  }
  await runtime.refresh({ allowNetwork: false });
  if (endpoint.apiKey) await runtime.setRuntimeApiKey(providerId, endpoint.apiKey);
  return runtime;
}

/** @brief 只写模型（不动连接和 key）：写 models.json 后 pi 重读。 */
async function writeModels(path: string, file: ModelsFile): Promise<ModelRuntime> {
  const runtime = await getRuntime();
  await writeJsonAtomic(path, file);
  await runtime.refresh({ allowNetwork: false });
  return runtime;
}

/** @brief 新会话默认的思考强度：支持思考时写 pi 设置的 modelThinkingLevels["provider/模型"]，不支持时删掉。 */
function applyModelThinking(settings: SettingsManager, providerId: string, form: ModelForm): void {
  if (form.reasoning) settings.setModelThinkingLevel(providerId, form.modelId, form.thinkingLevel);
  else settings.removeModelThinkingLevel(providerId, form.modelId);
}

/**
 * @brief 还没有默认模型、或默认模型已经不在（pi 重读 models.json 之后找不到）时，把这个模型设为默认。
 * @param followConnection 为真时默认模型在这个连接上也换成它（连接表单再次保存，见 saveConnection）
 */
function adoptDefault(runtime: ModelRuntime, settings: SettingsManager, providerId: string, modelId: string,
  followConnection: boolean): void {
  const provider = settings.getDefaultProvider();
  const model = settings.getDefaultModel();
  const live = Boolean(provider && model && runtime.getModel(provider, model));
  if (live && !(followConnection && provider === providerId)) return;
  settings.setDefaultModelAndProvider(providerId, modelId);
}

/** @brief 等设置写完，返回 pi 报告的错误（读 models.json 的错误和写设置的错误）；没有时为 null。 */
async function settle(runtime: ModelRuntime, settings?: SettingsManager): Promise<string | null> {
  await settings?.flush();
  const settingsErrors = settings?.drainErrors().map((item) => item.error.message) ?? [];
  return [runtime.getError(), ...settingsErrors].filter(Boolean).join('; ') || null;
}

/**
 * @brief 保存连接表单（首次启动、"Add connection"）：providerId 为 null 时新建一个连接（排在最后），否则改这个连接并写入
 *        （或更新）表单里的模型。没有默认模型时它成为默认；默认模型就在这个连接上时也换成它：首次启动测试失败、
 *        改了模型 ID 再保存测试，打开文件夹后的会话才用测试过的那个模型。返回保存到的连接和 pi 报告的配置错误。
 */
export function saveConnection(agentDir: string, providerId: string | null,
  connection: Connection): Promise<ConnectionSaveResult> {
  return serialize(async () => {
    const path = modelsPath(agentDir);
    const file = await readModelsForEdit(path);
    const id = providerId ?? nextProviderId(file);
    const previous = providerId ? requireProvider(file, providerId) : {};
    const provider = upsertModel(mergeEndpoint(previous, connection), connection);
    const runtime = await writeProvider(path, file, id, provider, connection);
    const settings = await globalSettings();
    applyModelThinking(settings, id, connection);
    adoptDefault(runtime, settings, id, connection.modelId, true);
    return { providerId: id, error: await settle(runtime, settings) };
  });
}

/** @brief 只改连接（地址、接口类型、key、兼容选项），不动它下面的模型。 */
export function saveEndpoint(agentDir: string, providerId: string, endpoint: Endpoint): Promise<SaveResult> {
  return serialize(async () => {
    const path = modelsPath(agentDir);
    const file = await readModelsForEdit(path);
    const provider = mergeEndpoint(requireProvider(file, providerId), endpoint);
    const runtime = await writeProvider(path, file, providerId, provider, endpoint);
    return { error: await settle(runtime) };
  });
}

/** @brief 添加（adding 为真；ID 已存在时报错）或修改连接下的一个模型；不改 key。没有默认模型时它成为默认。 */
export function saveModel(agentDir: string, providerId: string, model: ModelForm,
  adding: boolean): Promise<SaveResult> {
  return serialize(async () => {
    const path = modelsPath(agentDir);
    const file = await readModelsForEdit(path);
    const provider = requireProvider(file, providerId);
    const exists = modelsOf(provider).some((item) => item.id === model.modelId);
    if (adding && exists) throw new Error(`Model ${model.modelId} already exists in this connection`);
    if (!adding && !exists) throw new Error(`Model ${providerId}/${model.modelId} not found in models.json`);
    file.providers = { ...file.providers, [providerId]: upsertModel(provider, model) };
    const runtime = await writeModels(path, file);
    const settings = await globalSettings();
    applyModelThinking(settings, providerId, model);
    adoptDefault(runtime, settings, providerId, model.modelId, false);
    return { error: await settle(runtime, settings) };
  });
}

/** @brief 默认模型（还有别的模型时）和唯一的模型不能删除（settings.md "不能删除"）。 */
function refuseDelete(file: ModelsFile, settings: SettingsManager, ref: string): void {
  const total = moriProviderIds(file).reduce((sum, id) => sum + modelsOf(file.providers?.[id]).length, 0);
  if (total <= 1) throw new Error('Cannot delete the only model');
  if (`${settings.getDefaultProvider()}/${settings.getDefaultModel()}` === ref) {
    throw new Error('Cannot delete the default model; set another model as the default first');
  }
}

/**
 * @brief 连接删掉之后删除它的 key：先删主进程加密保存的，再删 pi 内存里的。这时 models.json 已经改了，失败不再抛错
 *        （界面会以为没有删掉），记录后返回原文，和 pi 的错误一起交给界面；成功时返回 null。
 */
async function forgetKey(runtime: ModelRuntime, providerId: string): Promise<string | null> {
  try {
    await requestStoreKey(providerId, null);
    if (hasKey(runtime, providerId)) await runtime.removeRuntimeApiKey(providerId);
    return null;
  } catch (error) {
    const message = `Cannot delete the key of ${providerId}: ${(error as Error).message}`;
    console.error(`[kernel] ${message}`);
    return message;
  }
}

/**
 * @brief 删除模型和它的新会话思考强度设置；是连接的最后一个模型时连接和它的 key 一起删除。
 *        默认模型（还有别的模型时）和唯一的模型不能删。
 */
export function deleteModel(agentDir: string, providerId: string, modelId: string): Promise<SaveResult> {
  return serialize(async () => {
    const path = modelsPath(agentDir);
    const file = await readModelsForEdit(path);
    const provider = requireProvider(file, providerId);
    const models = modelsOf(provider);
    if (!models.some((item) => item.id === modelId)) {
      throw new Error(`Model ${providerId}/${modelId} not found in models.json`);
    }
    const settings = await globalSettings();
    refuseDelete(file, settings, `${providerId}/${modelId}`);
    const rest = models.filter((item) => item.id !== modelId);
    const { [providerId]: _removed, ...others } = file.providers ?? {};
    file.providers = rest.length ? { ...file.providers, [providerId]: { ...provider, models: rest } } : others;
    const runtime = await writeModels(path, file);
    settings.removeModelThinkingLevel(providerId, modelId);
    const keyError = rest.length ? null : await forgetKey(runtime, providerId);
    return { error: [await settle(runtime, settings), keyError].filter(Boolean).join('; ') || null };
  });
}

/** @brief 设为默认模型（pi 设置的 defaultProvider / defaultModel）；新会话用它，已经打开的会话不变。 */
export function setDefaultModel(providerId: string, modelId: string): Promise<SaveResult> {
  return serialize(async () => {
    const runtime = await getRuntime();
    if (!runtime.getModel(providerId, modelId)) throw new Error(`Model ${providerId}/${modelId} not found`);
    const settings = await globalSettings();
    settings.setDefaultModelAndProvider(providerId, modelId);
    return { error: await settle(runtime, settings) };
  });
}

/** @brief 要测试的模型：给了 provider 和模型就测它，否则测默认模型；找不到时返回错误原文。 */
async function testTarget(runtime: ModelRuntime, providerId?: string, modelId?: string): Promise<PiModel | string> {
  const settings = await globalSettings();
  const given = Boolean(providerId && modelId);
  const provider = given ? providerId : settings.getDefaultProvider();
  const id = given ? modelId : settings.getDefaultModel();
  if (!provider || !id) return 'No connection saved yet; save the connection first';
  return runtime.getModel(provider, id) ?? runtime.getError() ?? `Model ${provider}/${id} not found in models.json`;
}

/**
 * @brief 用给定的模型（不给时用默认模型）发一条短消息，记录到第一个增量（正文或思考）的时间；
 *        你点"Cancel"或超时都会中止。
 */
export async function testConnection(providerId?: string, modelId?: string): Promise<TestResult> {
  const started = Date.now();
  const runtime = await getRuntime();
  const result: TestResult = { ok: false, cancelled: false, firstTokenMs: null, totalMs: 0, text: '', thinking: false,
    error: null };
  const model = await testTarget(runtime, providerId, modelId);
  if (typeof model === 'string') return { ...result, error: model };
  const message = { role: 'user' as const, content: 'Reply with one short sentence.', timestamp: started };
  const controller = new AbortController();
  runningTest?.abort();
  runningTest = controller;
  const timeout = AbortSignal.timeout(TEST_TIMEOUT_MS);
  const signal = AbortSignal.any([timeout, controller.signal]);
  try {
    const options = { maxTokens: TEST_MAX_TOKENS, signal };
    for await (const event of runtime.streamSimple(model, { messages: [message] }, options)) {
      if (event.type === 'text_delta' || event.type === 'thinking_delta') result.firstTokenMs ??= Date.now() - started;
      if (event.type === 'text_delta') result.text += event.delta;
      if (event.type === 'thinking_delta') result.thinking = true;
      if (event.type === 'error') result.error = event.error.errorMessage ?? 'Request failed';
    }
  } catch (error) {
    result.error = (error as Error).message;
  } finally {
    if (runningTest === controller) runningTest = null;
  }
  result.cancelled = controller.signal.aborted;
  if (result.cancelled) result.error = 'Cancelled';
  else if (timeout.aborted) result.error = `No response within ${TEST_TIMEOUT_MS / 1000} seconds`;
  if (result.error && !result.cancelled) console.error(`[kernel] connection test failed: ${result.error}`);
  const ok = result.error === null && (result.text.length > 0 || result.thinking);
  return { ...result, ok, totalMs: Date.now() - started, text: result.text.slice(0, 200) };
}

/** @brief 取消正在进行的测试连接；没有在测试时返回 false。 */
export function cancelTest(): boolean {
  if (!runningTest) return false;
  runningTest.abort();
  return true;
}
