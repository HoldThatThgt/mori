// 模型层的 models.* 命令（docs/specs/model-providers.md §9.5、§4.1、§9.1）：每个写命令在模型层的修改队列里算出新配置，
// 经 ModelLayer.save 校验、编译到 pi（出错回滚）、原子写文件、交给模型池、通知会话重新做静态校验、按 §7.4 发起探针。
// 新 key 先请主进程加密保存，配置写失败时删掉本次新存的 key（§9.1）；删掉的 key 在配置保存后删除密文。
// 结果都带 error：失败时是原文，配置不变。
// 一键拉取模型（docs/specs/model-discovery.md §5）：models.discover、models.discoverCancel 不进修改队列，交给模型层的
// 读取器；加模型只有 saveProvider（新建）、firstRun、addModels，一次命令一次编译、一次写入，加入的模型都自动探测；
// saveModel 只改已有的模型。

import {
  DEFAULT_ZONES, MODEL_LIMITS,
  type DeleteResult, type DiscoverResult, type DiscoverTarget, type KeyAdded, type ModelCommand, type ModelConfig,
  type ModelPick, type ModelProvider, type ModelsInfo, type ModelsResult, type ProviderModel, type ProviderSaved,
  type ThinkingLevel,
} from '../shared/models';
import { setModelThinkingLevel } from './config';
import { normalizeBaseUrl } from './discoverRead';
import {
  applyAddressChange, deleteGroup, deleteModel, deleteProvider, findProvider, generateId, nextKeyRef,
  normalizeProjectPath, takenIds, type CascadeResult,
} from './modelConfig';
import { discoverFailure, type DiscoverRequest } from './modelDiscover';
import { getModelLayer, type ModelLayer } from './modelLayer';
import type { ModelRef } from './modelTypes';

/** @brief models.* 命令（connection.test 与 session.* 不在其中）。 */
export type ModelsCommand = Extract<ModelCommand, { type: `models.${string}` }>;

/** @brief 一条 models.* 命令。 */
type Cmd<T extends ModelsCommand['type']> = Extract<ModelsCommand, { type: T }>;

/** @brief 一次保存要交给 ModelLayer.save 的内容。 */
interface Draft {
  /** 新配置 */
  next: ModelConfig;
  /** 保存前的配置；首次写入时为 null */
  previous: ModelConfig | null;
  /** 本次新加的 key（先加密保存，写配置失败时删除）；没有时为 null */
  newKey: { ref: string; secret: string } | null;
  /** 一起删除的 key */
  removedKeyRefs?: readonly string[];
  /** 一起删除的模型 */
  removedRefs?: readonly ModelRef[];
  /** 要自动探测的模型（新加的模型、首次启动表单、加删 key 时未验证的模型） */
  probeRefs?: readonly ModelRef[];
}

/** @brief 能写进认证头的 key：可打印 ASCII，没有空格（§8.4 第 2 步）。 */
const HEADER_SAFE_KEY = /^[\x21-\x7e]+$/;

/**
 * @brief 检查要保存的 key 能写进请求头：去掉首尾空白后只含可打印 ASCII、没有空格。
 *        粘贴带进来的零宽字符、全角字符、换行会让发请求时写头失败，所以保存前就拒绝。
 *        models.discover 的临时 key 按同一条规则检查（model-discovery.md §5.1）。
 * @param secret 你填的 key
 * @return 去掉首尾空白后的 key
 * @throws key 含不能写进请求头的字符（错误文字不带 key）
 */
export function headerSafeSecret(secret: string): string {
  const trimmed = secret.trim();
  if (!HEADER_SAFE_KEY.test(trimmed)) throw new Error('API key contains characters that cannot be sent in a header');
  return trimmed;
}

/** @brief 新建配置（首次启动表单第一次保存时）：没有分组、没有默认范围，所有项目默认允许 local 与 intranet。 */
function emptyConfig(): ModelConfig {
  return { version: 1, providers: [], groups: [], normalDefault: null, allowedZones: [...DEFAULT_ZONES],
    projectZones: {} };
}

/** @brief 有配置时返回它；首次启动前或读不出时报错。 */
function requireConfig(layer: ModelLayer, config: ModelConfig | null): ModelConfig {
  if (config) return config;
  const error = layer.configError();
  throw new Error(error ? `Model settings can’t be read: ${error}` : 'No model settings yet');
}

/** @brief 按 id 找提供商，找不到时报错。 */
function requireProvider(config: ModelConfig, providerId: string): ModelProvider {
  const provider = findProvider(config, providerId);
  if (!provider) throw new Error(`${providerId} is not in your model settings`);
  return provider;
}

/** @brief 换掉配置里同 id 的提供商。 */
function replaceProvider(config: ModelConfig, provider: ModelProvider): ModelConfig {
  return { ...config, providers: config.providers.map((item) => (item.id === provider.id ? provider : item)) };
}

/** @brief 这些模型的 <provider>/<model>，按给出的顺序（model-discovery.md §5.4：加入的模型全部自动探测）。 */
function modelRefs(providerId: string, models: readonly ProviderModel[]): ModelRef[] {
  return models.map((model) => `${providerId}/${model.id}`);
}

/**
 * @brief 给提供商加一个 key（加在末尾，§4.1）：ref 为 <提供商 id>#<nextKeyNumber>，之后 nextKeyNumber 加 1。
 * @param config 配置（已含这个提供商）
 * @param providerId 提供商
 * @param label 标签
 * @return 新配置与新 key 的 ref
 */
function withNewKey(config: ModelConfig, providerId: string, label: string): { config: ModelConfig; ref: string } {
  const provider = requireProvider(config, providerId);
  if (provider.keys.length >= MODEL_LIMITS.maxKeys) {
    throw new Error(`A provider can have at most ${MODEL_LIMITS.maxKeys} keys.`);
  }
  const next = nextKeyRef(config, providerId);
  const keys = [...provider.keys, { ref: next.ref, label }];
  const updated = { ...provider, keys, nextKeyNumber: next.nextKeyNumber };
  return { config: replaceProvider(config, updated), ref: next.ref };
}

/** @brief 给配置里的提供商加上首次启动表单或新提供商表单的第一个 key（标签 Key 1）；没有 secret 时不加。 */
function withFirstKey(config: ModelConfig, providerId: string,
  secret: string | null | undefined): { config: ModelConfig; newKey: Draft['newKey'] } {
  if (!secret) return { config, newKey: null };
  const safe = headerSafeSecret(secret);
  const added = withNewKey(config, providerId, 'Key 1');
  return { config: added.config, newKey: { ref: added.ref, secret: safe } };
}

/**
 * @brief 保存一份草稿：新 key 先加密保存；保存失败时删掉本次新存的 key（§9.1）再抛出。
 * @return 删除去掉的 key 的密文失败时的原文；没有时为 null
 */
async function saveDraft(layer: ModelLayer, draft: Draft): Promise<string | null> {
  if (draft.newKey) await layer.storeSecret(draft.newKey.ref, draft.newKey.secret);
  try {
    return await layer.save(draft.next, {
      previous: draft.previous, removedKeyRefs: draft.removedKeyRefs, removedRefs: draft.removedRefs,
      probeRefs: draft.probeRefs,
      newSecrets: draft.newKey ? new Map([[draft.newKey.ref, draft.newKey.secret]]) : undefined,
    });
  } catch (error) {
    if (draft.newKey) await layer.forgetKeys([draft.newKey.ref]);
    throw error;
  }
}

/** @brief 记录并返回失败的原文。 */
function failure(type: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[kernel] ${type} failed: ${message}`);
  return message;
}

/**
 * @brief 在模型层的修改队列里执行一个写命令；失败时结果为 fallback 加上原文。
 * @param layer 模型层
 * @param type 命令类型（日志用）
 * @param task 拿到当前配置，返回结果（不含 error）与需要提示的原文
 * @param fallback 失败时的结果
 */
async function write<T extends object>(layer: ModelLayer, type: string,
  task: (config: ModelConfig | null) => Promise<{ value: T; warning: string | null }>,
  fallback: T): Promise<T & ModelsResult> {
  try {
    const { value, warning } = await layer.edit(task);
    return { ...value, error: warning };
  } catch (error) {
    return { ...fallback, error: failure(type, error) };
  }
}

// ---- 首次启动（§9.1、§9.4） ----

/**
 * @brief 首次启动表单的默认范围（model-discovery.md §5.4）：只有一个模型时为 <provider>/<model>，多个时为提供商 id。
 * @param providerId 提供商
 * @param models 勾选的模型（1 个以上）
 */
function firstRunDefault(providerId: string, models: readonly ProviderModel[]): ModelPick {
  return models.length === 1 ? `${providerId}/${models[0].id}` : providerId;
}

/**
 * @brief 首次启动表单第一次保存：一次写入提供商、勾选的全部模型（按清单顺序）、key 与 normalDefault；
 *        加入的模型都自动探测（model-discovery.md §5.4）。
 */
function firstRunCreate(layer: ModelLayer, command: Cmd<'models.firstRun'>): Draft {
  const id = generateId(command.provider.name, layer.reserved);
  const provider: ModelProvider = { id, ...command.provider, keys: [], nextKeyNumber: 1, models: [...command.models] };
  const base: ModelConfig = { ...emptyConfig(), providers: [provider],
    normalDefault: firstRunDefault(id, command.models) };
  const { config, newKey } = withFirstKey(base, id, command.keySecret);
  return { next: config, previous: null, newKey, probeRefs: modelRefs(id, command.models) };
}

/**
 * @brief 同一张首次启动表单再次保存：整体替换这个提供商和它的全部模型（model-discovery.md §5.4）；keySecret 为空时
 *        保留已存的 key，有时换成新 key（旧 key 保存后删除）；地址的 origin 变了时按 §4.1 删除已存的 key。
 */
function firstRunReplace(config: ModelConfig, command: Cmd<'models.firstRun'>, providerId: string): Draft {
  const old = requireProvider(config, providerId);
  const moved = applyAddressChange(old, command.provider.baseUrl);
  const removedKeyRefs = [...moved.removedKeyRefs];
  let provider: ModelProvider = { ...moved.provider, ...command.provider, models: [...command.models] };
  if (command.keySecret) {
    removedKeyRefs.push(...provider.keys.map((key) => key.ref));
    provider = { ...provider, keys: [] };
  }
  const refs = modelRefs(providerId, command.models);
  const base = { ...replaceProvider(config, provider), normalDefault: firstRunDefault(providerId, command.models) };
  const { config: next, newKey } = withFirstKey(base, providerId, command.keySecret);
  const kept = new Set(refs);
  const removedRefs = modelRefs(providerId, old.models).filter((ref) => !kept.has(ref));
  return { next, previous: config, newKey, removedKeyRefs, removedRefs, probeRefs: refs };
}

/**
 * @brief models.firstRun：model-config.json 已存在、且要写的不是这张表单自己建的提供商时拒绝（§9.4）。
 *        一次编译、一次写入；不写新会话的思考强度（model-discovery.md §5.4）。
 */
function firstRun(layer: ModelLayer, command: Cmd<'models.firstRun'>): Promise<ProviderSaved> {
  return write(layer, command.type, async (config) => {
    if (layer.configError() !== null) throw new Error(`Model settings can’t be read: ${layer.configError()}`);
    const own = command.providerId !== null && command.providerId === layer.firstRunProvider();
    if (config !== null && !own) throw new Error('Model settings already exist; change them in Settings → Models');
    const draft = config === null ? firstRunCreate(layer, command)
      : firstRunReplace(config, command, command.providerId as string);
    const warning = await saveDraft(layer, draft);
    const providerId = draft.next.providers[0].id;
    layer.setFirstRunProvider(providerId);
    return { value: { providerId }, warning };
  }, { providerId: command.providerId ?? '' });
}

/**
 * @brief 写 pi 设置的新会话思考强度（沿用 v0）：模型不支持思考时删掉这一项，支持且给了强度时写入。
 * @return pi 写设置时报告的错误；没有时为 null
 */
async function saveThinking(providerId: string, model: ProviderModel,
  level: ThinkingLevel | undefined): Promise<string | null> {
  if (!model.reasoning) return setModelThinkingLevel(providerId, model.id, null);
  return level ? setModelThinkingLevel(providerId, model.id, level) : null;
}

/** @brief 合并配置保存与思考强度写入的警告；都没有时为 null。 */
function joinWarnings(...warnings: (string | null)[]): string | null {
  return warnings.filter(Boolean).join('; ') || null;
}

// ---- 提供商 ----

/**
 * @brief 新建提供商（§9.1）：id 由名称生成，带清单里勾选的模型（model-discovery.md §5.4：1 个以上，按清单顺序，
 *        全部自动探测）和可选的第一个 key，排在最后。
 */
function providerCreate(layer: ModelLayer, config: ModelConfig, command: Cmd<'models.saveProvider'>): Draft {
  if (!command.models) throw new Error('A new provider needs at least one model');
  const id = generateId(command.provider.name, takenIds(config, layer.reserved));
  const provider: ModelProvider = { id, ...command.provider, keys: [], nextKeyNumber: 1, models: [...command.models] };
  const base = { ...config, providers: [...config.providers, provider] };
  const { config: next, newKey } = withFirstKey(base, id, command.keySecret);
  return { next, previous: config, newKey, probeRefs: modelRefs(id, command.models) };
}

/**
 * @brief 修改提供商（§4.1）：地址的 origin 变了时删除它的全部 key；key 与模型不在这里改（带了 models 也不看，
 *        同原来不看 model）。
 */
function providerEdit(config: ModelConfig, providerId: string, command: Cmd<'models.saveProvider'>): Draft {
  const moved = applyAddressChange(requireProvider(config, providerId), command.provider.baseUrl);
  const provider: ModelProvider = { ...moved.provider, ...command.provider };
  return { next: replaceProvider(config, provider), previous: config, newKey: null,
    removedKeyRefs: moved.removedKeyRefs };
}

/**
 * @brief models.saveProvider：新建（id 为 null）或修改。新建时不写新会话的思考强度（model-discovery.md §5.4：
 *        勾了 Supports thinking 的模型按 pi 设置的 defaultThinkingLevel，之后在 Edit 里设）。
 */
function saveProvider(layer: ModelLayer, command: Cmd<'models.saveProvider'>): Promise<ProviderSaved> {
  return write(layer, command.type, async (current) => {
    const config = requireConfig(layer, current);
    const draft = command.id === null ? providerCreate(layer, config, command)
      : providerEdit(config, command.id, command);
    const warning = await saveDraft(layer, draft);
    const providerId = command.id ?? draft.next.providers[draft.next.providers.length - 1].id;
    return { value: { providerId }, warning };
  }, { providerId: command.id ?? '' });
}

/**
 * @brief 删除提供商、模型或分组（§4.1 的连带改动）：dryRun 时只算出确认框的各行，不改配置。
 * @param cascade 由当前配置算出删除后的配置与连带改动
 */
function remove(layer: ModelLayer, type: string, dryRun: boolean,
  cascade: (config: ModelConfig) => CascadeResult): Promise<DeleteResult> {
  return write(layer, type, async (current) => {
    const config = requireConfig(layer, current);
    const result = cascade(config);
    if (dryRun) return { value: { consequences: result.consequences }, warning: null };
    const warning = await saveDraft(layer, { next: result.config, previous: config, newKey: null,
      removedKeyRefs: result.removedKeyRefs, removedRefs: result.removedRefs });
    return { value: { consequences: result.consequences }, warning };
  }, { consequences: [] });
}

// ---- 模型 ----

/**
 * @brief models.saveModel：只改已有的模型（model-discovery.md §5.4：加模型只有 saveProvider、firstRun、addModels），
 *        模型不存在时报错；再写 pi 设置的新会话思考强度（沿用 v0）。指纹变了的模型保存后按 §7.4 重新探测。
 */
function saveModel(layer: ModelLayer, command: Cmd<'models.saveModel'>): Promise<ModelsResult> {
  const { providerId, model } = command;
  return write(layer, command.type, async (current) => {
    const config = requireConfig(layer, current);
    const provider = requireProvider(config, providerId);
    if (!provider.models.some((item) => item.id === model.id)) {
      throw new Error(`${providerId}/${model.id} is not in your model settings`);
    }
    const models = provider.models.map((item) => (item.id === model.id ? model : item));
    const saved = await saveDraft(layer, { next: replaceProvider(config, { ...provider, models }), previous: config,
      newKey: null });
    const thinking = await saveThinking(providerId, model, command.thinkingLevel);
    return { value: {}, warning: joinWarnings(saved, thinking) };
  }, {});
}

/**
 * @brief models.addModels（model-discovery.md §5.4）：卡上清单的 Add，加在这个提供商已有的模型之后，按清单顺序；
 *        任一 id 已在其中、或同一次里重复时整次拒绝（“<id> is already in <provider name>.”），配置不变。
 *        一次编译、一次写入；加入的每个模型都自动探测。
 */
function addModels(layer: ModelLayer, command: Cmd<'models.addModels'>): Promise<ModelsResult> {
  return write(layer, command.type, async (current) => {
    const config = requireConfig(layer, current);
    const provider = requireProvider(config, command.providerId);
    const ids = new Set(provider.models.map((model) => model.id));
    for (const model of command.models) {
      if (ids.has(model.id)) throw new Error(`${model.id} is already in ${provider.name}.`);
      ids.add(model.id);
    }
    const models = [...provider.models, ...command.models];
    const warning = await saveDraft(layer, { next: replaceProvider(config, { ...provider, models }), previous: config,
      newKey: null, probeRefs: modelRefs(provider.id, command.models) });
    return { value: {}, warning };
  }, {});
}

/**
 * @brief 把列表里的一项移动一格。
 * @throws 已在最前或最后、或找不到时
 */
function moved<T>(items: readonly T[], index: number, delta: -1 | 1, name: string): T[] {
  const target = index + delta;
  if (index < 0) throw new Error(`${name} is not in your model settings`);
  if (target < 0 || target >= items.length) throw new Error(`Cannot move ${name} further`);
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** @brief models.moveModel：模型上移或下移（范围里的顺序随之变）。 */
function moveModel(layer: ModelLayer, command: Cmd<'models.moveModel'>): Promise<ModelsResult> {
  return write(layer, command.type, async (current) => {
    const config = requireConfig(layer, current);
    const provider = requireProvider(config, command.providerId);
    const index = provider.models.findIndex((item) => item.id === command.modelId);
    const models = moved(provider.models, index, command.delta, `${command.providerId}/${command.modelId}`);
    const warning = await saveDraft(layer, { next: replaceProvider(config, { ...provider, models }), previous: config,
      newKey: null });
    return { value: {}, warning };
  }, {});
}

// ---- key（§4.1、§9.1） ----

/**
 * @brief 加 key、删 key 也算修改提供商（§7.4）：这个提供商里档案不是已验证或验证失败的模型重新探测
 *        （没有档案、或上次因出错为 unverified 的，例如 key 错了）。
 * @param layer 模型层
 * @param provider 提供商（修改前的）
 */
function keyChangeProbes(layer: ModelLayer, provider: ModelProvider): ModelRef[] {
  return provider.models.map((model) => `${provider.id}/${model.id}`).filter((ref) => {
    const state = layer.profileOf(ref)?.tool_calling.state;
    return state !== 'verified' && state !== 'failed';
  });
}

/** @brief models.addKey：加在末尾；明文先加密保存，配置写失败时删除。 */
function addKey(layer: ModelLayer, command: Cmd<'models.addKey'>): Promise<KeyAdded> {
  return write(layer, command.type, async (current) => {
    const config = requireConfig(layer, current);
    const secret = headerSafeSecret(command.secret);
    const added = withNewKey(config, command.providerId, command.label);
    const probeRefs = keyChangeProbes(layer, requireProvider(config, command.providerId));
    const warning = await saveDraft(layer, { next: added.config, previous: config,
      newKey: { ref: added.ref, secret }, probeRefs });
    return { value: { ref: added.ref }, warning };
  }, { ref: '' });
}

/** @brief models.removeKey：去掉 key，配置保存后删除它的密文（编号不再用）。 */
function removeKey(layer: ModelLayer, command: Cmd<'models.removeKey'>): Promise<ModelsResult> {
  return write(layer, command.type, async (current) => {
    const config = requireConfig(layer, current);
    const provider = requireProvider(config, command.providerId);
    if (!provider.keys.some((key) => key.ref === command.ref)) throw new Error(`Key ${command.ref} is not saved`);
    const keys = provider.keys.filter((key) => key.ref !== command.ref);
    const warning = await saveDraft(layer, { next: replaceProvider(config, { ...provider, keys }), previous: config,
      newKey: null, removedKeyRefs: [command.ref], probeRefs: keyChangeProbes(layer, provider) });
    return { value: {}, warning };
  }, {});
}

/** @brief models.moveKey：key 上移或下移（使用顺序随之变）。 */
function moveKey(layer: ModelLayer, command: Cmd<'models.moveKey'>): Promise<ModelsResult> {
  return write(layer, command.type, async (current) => {
    const config = requireConfig(layer, current);
    const provider = requireProvider(config, command.providerId);
    const index = provider.keys.findIndex((key) => key.ref === command.ref);
    const keys = moved(provider.keys, index, command.delta, `Key ${command.ref}`);
    const warning = await saveDraft(layer, { next: replaceProvider(config, { ...provider, keys }), previous: config,
      newKey: null });
    return { value: {}, warning };
  }, {});
}

// ---- 分组、默认值、区域 ----

/** @brief models.saveGroup：新建（creating 为真，id 不能与提供商、分组或保留 id 重复）或修改成员。 */
function saveGroup(layer: ModelLayer, command: Cmd<'models.saveGroup'>): Promise<ModelsResult> {
  const { id, members, creating } = command;
  return write(layer, command.type, async (current) => {
    const config = requireConfig(layer, current);
    const exists = config.groups.some((group) => group.id === id);
    if (creating && layer.reserved.includes(id)) throw new Error(`${id} is reserved`);
    if (creating && takenIds(config, layer.reserved).has(id)) {
      throw new Error(`${id} is already used by a provider or group`);
    }
    if (!creating && !exists) throw new Error(`${id} is not in your model settings`);
    const groups = creating ? [...config.groups, { id, members: [...members] }]
      : config.groups.map((group) => (group.id === id ? { id, members: [...members] } : group));
    const warning = await saveDraft(layer, { next: { ...config, groups }, previous: config, newKey: null });
    return { value: {}, warning };
  }, {});
}

/**
 * @brief 改配置里的一处（默认值、项目授权、区域确认）并保存。
 * @param change 由当前配置算出新配置
 */
function update(layer: ModelLayer, type: string,
  change: (config: ModelConfig) => ModelConfig): Promise<ModelsResult> {
  return write(layer, type, async (current) => {
    const config = requireConfig(layer, current);
    const warning = await saveDraft(layer, { next: change(config), previous: config, newKey: null });
    return { value: {}, warning };
  }, {});
}

/** @brief models.setProjectZones：本机为这个项目在 allowedZones 之外额外允许的区域；为空时删掉这一项（§4.1）。 */
function setProjectZones(config: ModelConfig, command: Cmd<'models.setProjectZones'>): ModelConfig {
  const path = normalizeProjectPath(command.path);
  const projectZones = { ...config.projectZones };
  if (command.zones.length === 0) delete projectZones[path];
  else projectZones[path] = [...command.zones];
  return { ...config, projectZones };
}

/** @brief models.confirmZone：确认（或改）一个提供商的区域。 */
function confirmZone(config: ModelConfig, command: Cmd<'models.confirmZone'>): ModelConfig {
  return replaceProvider(config, { ...requireProvider(config, command.providerId), zone: command.zone });
}

// ---- 读取、重读、探针 ----

/** @brief 读取失败时的 models.get 结果。 */
function emptyInfo(error: string): ModelsInfo {
  return { error, config: null, profiles: {}, keyStatus: {}, thinkingDefaults: {}, zoneSuggestions: {},
    migration: null, projects: [], loadError: null, reserved: [] };
}

/** @brief models.get / models.reload。 */
async function readInfo(layer: ModelLayer, type: string, reload: boolean): Promise<ModelsInfo> {
  try {
    if (reload) await layer.reload();
    return await layer.info();
  } catch (error) {
    return emptyInfo(failure(type, error));
  }
}

/** @brief models.verify：自动的第 0–7 步，或需要你同意的长输入、取消探针（§7.4）；在后台跑，不等结果。 */
async function verify(layer: ModelLayer, command: Cmd<'models.verify'>): Promise<ModelsResult> {
  try {
    requireConfig(layer, layer.getConfig());
    const error = layer.startProbes(command.refs, command.tests);
    if (error !== null) failure(command.type, error);
    return { error };
  } catch (error) {
    return { error: failure(command.type, error) };
  }
}

/** @brief models.dismissMigration：删除迁移说明（§4.5）。 */
async function dismissMigration(layer: ModelLayer): Promise<ModelsResult> {
  try {
    await layer.dismissMigration();
    return { error: null };
  } catch (error) {
    return { error: failure('models.dismissMigration', error) };
  }
}

// ---- 拉取模型（model-discovery.md §5.1–§5.3） ----

/**
 * @brief models.discover 要读的新提供商（§5.1、§3.1）：按 §3.1 整理地址；key 去掉首尾空白，为空时不带认证头，
 *        否则按保存 key 的同一条规则检查。key 只在这次读取里用：不存、不进模型池、不写日志。
 * @throws 地址不是 http 或 https URL；key 含不能写进请求头的字符（错误文字不带 key）
 */
function newTarget(target: Extract<DiscoverTarget, { kind: 'new' }>): DiscoverRequest {
  const normalized = normalizeBaseUrl(target.baseUrl);
  if (!normalized) throw new Error('Base URL must be an http or https URL.');
  const key = target.keySecret?.trim() ?? '';
  return { base: normalized.base, anthropicHint: normalized.anthropicHint, existing: false,
    secret: key === '' ? null : headerSafeSecret(key), shareKey: null, api: target.api, configured: [] };
}

/**
 * @brief models.discover 要读的已有提供商（§5.1）：地址与 api 用配置里的，不整理、不识别；key 由模型层按 §5.1 选，
 *        不回到界面；configured 给结果的 added、notListed。
 * @throws 没有配置或读不出；提供商不存在
 */
function providerTarget(layer: ModelLayer, providerId: string): DiscoverRequest {
  const provider = requireProvider(requireConfig(layer, layer.getConfig()), providerId);
  return { ...layer.readTarget(provider), api: provider.api, configured: provider.models.map((model) => model.id) };
}

/**
 * @brief models.discover（§5.1–§5.3）：不进修改队列（layer.edit）、不写配置；同一时刻只做一次，由读取器取消正在进行的
 *        那次。命令本身失败（地址、key 不合格，提供商不存在）时 error 为原文，这时也取消正在进行的那次（§5.3：
 *        新的一次到来时取消旧的）。
 */
async function discover(layer: ModelLayer, command: Cmd<'models.discover'>): Promise<DiscoverResult> {
  const { target } = command;
  try {
    const request = target.kind === 'new' ? newTarget(target) : providerTarget(layer, target.providerId);
    return await layer.reader.command(request);
  } catch (error) {
    layer.reader.cancelCommand();
    return discoverFailure(failure(command.type, error));
  }
}

/** @brief models.discoverCancel（§5.3）：取消正在进行的 models.discover，没有时什么也不做；不取消探针第 0 步与读版本。 */
function discoverCancel(layer: ModelLayer): ModelsResult {
  layer.reader.cancelCommand();
  return { error: null };
}

/** @brief 删除与改动类的写命令；不是这几种时返回 undefined。 */
function handleEdit(layer: ModelLayer, command: ModelsCommand): Promise<unknown> | undefined {
  switch (command.type) {
    case 'models.deleteProvider':
      return remove(layer, command.type, command.dryRun, (config) => deleteProvider(config, command.id));
    case 'models.deleteModel':
      return remove(layer, command.type, command.dryRun,
        (config) => deleteModel(config, command.providerId, command.modelId));
    case 'models.deleteGroup':
      return remove(layer, command.type, command.dryRun, (config) => deleteGroup(config, command.id));
    case 'models.setDefaults':
      return update(layer, command.type, (config) => ({ ...config, normalDefault: command.normalDefault,
        allowedZones: [...command.allowedZones] }));
    case 'models.setProjectZones':
      return update(layer, command.type, (config) => setProjectZones(config, command));
    case 'models.confirmZone':
      return update(layer, command.type, (config) => confirmZone(config, command));
    default:
      return undefined;
  }
}

/**
 * @brief 执行一条 models.* 命令（§9.5；model-discovery.md §5）。
 * @param command 已经过 zod 校验的命令
 */
export async function handleModelsCommand(command: ModelsCommand): Promise<unknown> {
  const layer = await getModelLayer();
  switch (command.type) {
    case 'models.get': return readInfo(layer, command.type, false);
    case 'models.reload': return readInfo(layer, command.type, true);
    case 'models.firstRun': return firstRun(layer, command);
    case 'models.saveProvider': return saveProvider(layer, command);
    case 'models.saveModel': return saveModel(layer, command);
    case 'models.addModels': return addModels(layer, command);
    case 'models.discover': return discover(layer, command);
    case 'models.discoverCancel': return discoverCancel(layer);
    case 'models.moveModel': return moveModel(layer, command);
    case 'models.addKey': return addKey(layer, command);
    case 'models.removeKey': return removeKey(layer, command);
    case 'models.moveKey': return moveKey(layer, command);
    case 'models.saveGroup': return saveGroup(layer, command);
    case 'models.dismissMigration': return dismissMigration(layer);
    case 'models.verify': return verify(layer, command);
    default: return handleEdit(layer, command);
  }
}

/**
 * @brief 命令是不是 models.*（由 handleModelsCommand 处理）。
 * @param command 已经过 zod 校验的命令
 */
export function isModelsCommand(command: { type: string }): command is ModelsCommand {
  return command.type.startsWith('models.');
}
