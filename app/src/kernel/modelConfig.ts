// 用户级模型配置 model-config.json 与项目配置 .mori/models.json（docs/specs/model-providers.md §4.1–§4.3、§5.1、§12）：
// 跨字段校验、由名称生成 id、新 key 的编号、删除的连带改动、改地址删 key、项目路径规范化、项目配置的解析与允许的区域、
// 选择范围的分类与展开、区域建议、旧会话的选择范围。
// 纯函数不读文件、不取时间；文件读写只在本文件末尾的几个函数里（原子写：先写临时文件再改名）。

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, win32 } from 'node:path';
import {
  addressChangeText, DEFAULT_ZONES, ModelConfigSchema, ProjectModelsFileSchema, VIRTUAL_PROVIDER_ID, ZONES, suggestZone,
  type ModelConfig, type ModelGroup, type ModelPick, type ModelProvider, type ProjectModelsFile, type Zone,
} from '../shared/models';
import type { ModelRef } from './modelTypes';
import { renameReplacing } from './renameRetry';

/** @brief 用户级配置的文件名（在 userData 下，§3）。 */
export const MODEL_CONFIG_FILE = 'model-config.json';
/** @brief 项目配置相对项目文件夹的位置（§3）。 */
export const PROJECT_MODELS_FILE = join('.mori', 'models.json');
/** @brief 提供商与分组 id 的最大长度（§4.1）。 */
const ID_MAX_LENGTH = 40;
/** @brief 名称里没有字母或数字（例如全是汉字）时生成的 id（§4.1）。 */
const FALLBACK_ID = 'provider';

// ---- 跨字段校验（§4.1） ----

/** @brief 配置的一处错误：位置与英文说明。 */
export interface ConfigIssue {
  /** 出错的位置，同 zod 的 issue.path，例如 ['providers', 0, 'id']；整个文件为 [] */
  path: (string | number)[];
  /** 英文说明 */
  message: string;
}

/** @brief 跨字段校验的参数。 */
export interface ValidateOptions {
  /** 保留 id：mori 和 pi 内置的提供商 id（见 reservedIds） */
  reserved: readonly string[];
  /** 保存前的配置，用来检查 nextKeyNumber 只增不减；没有（首次写入、读文件时）为 null 或省略 */
  previous?: ModelConfig | null;
}

/**
 * @brief 保留 id：会话虚拟模型用的 mori，加上 pi 内置的提供商 id（启动时从 pi 读出，§4.1）。
 * @param builtinProviderIds pi 内置的提供商 id
 */
export function reservedIds(builtinProviderIds: Iterable<string>): string[] {
  return [...new Set([VIRTUAL_PROVIDER_ID, ...builtinProviderIds])];
}

/** @brief 提供商 id 与分组 id 共用名字空间，不能重复，不能是保留 id。 */
function checkIds(config: ModelConfig, reserved: ReadonlySet<string>, issues: ConfigIssue[]): void {
  const seen = new Set<string>();
  const check = (id: string, path: (string | number)[]): void => {
    if (reserved.has(id)) issues.push({ path, message: `${id} is reserved` });
    else if (seen.has(id)) issues.push({ path, message: `${id} is already used by a provider or group` });
    seen.add(id);
  };
  config.providers.forEach((provider, index) => check(provider.id, ['providers', index, 'id']));
  config.groups.forEach((group, index) => check(group.id, ['groups', index, 'id']));
}

/** @brief key 的 ref 全局唯一。 */
function checkKeyRefs(config: ModelConfig, issues: ConfigIssue[]): void {
  const seen = new Set<string>();
  config.providers.forEach((provider, p) => provider.keys.forEach((key, k) => {
    if (seen.has(key.ref)) {
      issues.push({ path: ['providers', p, 'keys', k, 'ref'], message: `Key ref ${key.ref} is used more than once` });
    }
    seen.add(key.ref);
  }));
}

/** @brief 分组成员与 normalDefault 引用的名字都存在（§4.2 的文字，加上谁引用了它）。 */
function checkReferences(config: ModelConfig, issues: ConfigIssue[]): void {
  config.groups.forEach((group, g) => group.members.forEach((member, m) => {
    if (!memberExists(config, member)) {
      issues.push({ path: ['groups', g, 'members', m],
        message: `${member} is not in your model settings (member of group ${group.id})` });
    }
  }));
  if (config.normalDefault !== null && resolvePick(config, config.normalDefault).kind === 'missing') {
    issues.push({ path: ['normalDefault'],
      message: `${config.normalDefault} is not in your model settings (default model range)` });
  }
}

/** @brief 以 <id>#<n> 为 ref 的 key 的编号 n；不是这种写法时为 null。 */
function keyNumber(providerId: string, ref: string): number | null {
  const prefix = `${providerId}#`;
  if (!ref.startsWith(prefix)) return null;
  const rest = ref.slice(prefix.length);
  return /^[1-9]\d*$/.test(rest) ? Number(rest) : null;
}

/** @brief nextKeyNumber 只增不减，并且大于这个提供商已有的 <id>#<n> 编号（删掉的编号不再用）。 */
function checkKeyNumbers(config: ModelConfig, previous: ModelConfig | null, issues: ConfigIssue[]): void {
  config.providers.forEach((provider, index) => {
    const path = ['providers', index, 'nextKeyNumber'];
    const before = previous?.providers.find((item) => item.id === provider.id);
    if (before && provider.nextKeyNumber < before.nextKeyNumber) {
      issues.push({ path, message: `nextKeyNumber must not go back (was ${before.nextKeyNumber})` });
      return;
    }
    const used = provider.keys.map((key) => keyNumber(provider.id, key.ref) ?? 0);
    const highest = Math.max(0, ...used);
    if (provider.nextKeyNumber <= highest) {
      issues.push({ path, message: `nextKeyNumber must be greater than ${highest}, already used by a key` });
    }
  });
}

/** @brief allowedZones 只能是 local、intranet 的子集（公网只能按项目授权）。 */
function checkAllowedZones(config: ModelConfig, issues: ConfigIssue[]): void {
  config.allowedZones.forEach((zone, index) => {
    if (!(DEFAULT_ZONES as readonly string[]).includes(zone)) {
      issues.push({ path: ['allowedZones', index], message: `${zone} can only be allowed per project` });
    }
  });
}

/**
 * @brief 跨字段校验（单字段的规则由 ModelConfigSchema 检查）：id 唯一且不是保留 id、key ref 全局唯一、
 *        引用的名字存在、nextKeyNumber 只增不减、allowedZones 不含 public。
 * @param config 已通过 ModelConfigSchema 的配置
 * @param options 保留 id 与保存前的配置
 * @return 全部错误；没有错误时为空数组
 */
export function validateConfig(config: ModelConfig, options: ValidateOptions): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  checkIds(config, new Set(options.reserved), issues);
  checkKeyRefs(config, issues);
  checkReferences(config, issues);
  checkKeyNumbers(config, options.previous ?? null, issues);
  checkAllowedZones(config, issues);
  return issues;
}

/** @brief 解析结果：成功时是配置，失败时是全部错误。 */
export type ConfigParse = { ok: true; config: ModelConfig } | { ok: false; issues: ConfigIssue[] };

/**
 * @brief 先按 ModelConfigSchema 严格校验（未知字段报错），通过后再做跨字段校验。
 * @param raw JSON.parse 的结果
 * @param options 保留 id 与保存前的配置
 */
export function parseModelConfig(raw: unknown, options: ValidateOptions): ConfigParse {
  const parsed = ModelConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.map((part) => (typeof part === 'number' ? part : String(part))),
      message: issue.message,
    }));
    return { ok: false, issues };
  }
  const issues = validateConfig(parsed.data, options);
  return issues.length ? { ok: false, issues } : { ok: true, config: parsed.data };
}

/**
 * @brief 把错误写成一行文字（设置页与拒绝启动卡显示的原文）：每处 "<位置>: <说明>"，用 "; " 连接。
 * @param issues 错误
 */
export function formatIssues(issues: readonly ConfigIssue[]): string {
  return issues.map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
}

// ---- 由名称生成 id、新 key 的 ref（§4.1） ----

/**
 * @brief 已被占用、不能再用作新 id 的名字：全部提供商 id、分组 id 和保留 id。
 * @param config 当前配置
 * @param reserved 保留 id
 */
export function takenIds(config: ModelConfig, reserved: readonly string[]): Set<string> {
  return new Set([...reserved, ...config.providers.map((item) => item.id), ...config.groups.map((item) => item.id)]);
}

/**
 * @brief 由名称生成 id（§4.1）：小写，非字母数字换成 -，去掉首尾 -，截到 40 个字符；结果为空（例如名称全是汉字）时
 *        用 provider；与占用的名字重复时加 -2、-3……（加后缀时把前面截短，使整个 id 不超过 40 个字符）。
 * @param name 名称（新建提供商时的 Name，迁移时的 v0 provider id）
 * @param taken 已占用的名字（见 takenIds）
 * @return 生成的 id
 */
export function generateId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const trimmed = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/^-+|-+$/g, '').slice(0, ID_MAX_LENGTH);
  const base = trimmed || FALLBACK_ID;
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, ID_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!used.has(id)) return id;
  }
}

/** @brief 新 key 的 ref 与之后的 nextKeyNumber。 */
export interface NextKey {
  /** <提供商 id>#<编号> */
  ref: string;
  /** 用掉这个编号之后的 nextKeyNumber */
  nextKeyNumber: number;
}

/** @brief 全部 key 的 ref。 */
function allKeyRefs(config: ModelConfig): Set<string> {
  return new Set(config.providers.flatMap((provider) => provider.keys.map((key) => key.ref)));
}

/**
 * @brief 新 key 的 ref：<提供商 id>#<nextKeyNumber>，之后加 1；删掉的编号不再用。
 *        这个 ref 已被别的 key 占用（迁移来的 key 沿用 v0 的 id 作 ref）时继续往后找，保证全局唯一。
 * @param config 当前配置
 * @param providerId 提供商 id
 */
export function nextKeyRef(config: ModelConfig, providerId: string): NextKey {
  const provider = requireProvider(config, providerId);
  const refs = allKeyRefs(config);
  let n = provider.nextKeyNumber;
  while (refs.has(`${provider.id}#${n}`)) n += 1;
  return { ref: `${provider.id}#${n}`, nextKeyNumber: n + 1 };
}

// ---- 名字与引用（§4.2） ----

/** @brief 选择范围指向的东西（§4.2）。 */
export type PickTarget =
  | { kind: 'group'; group: ModelGroup }
  | { kind: 'provider'; provider: ModelProvider }
  | { kind: 'model'; provider: ModelProvider; modelId: string }
  | { kind: 'missing' };

/**
 * @brief 把 <provider>/<model> 拆开：第一个 / 之前是提供商。
 * @return 不含 / 时为 null
 */
export function splitRef(ref: string): { providerId: string; modelId: string } | null {
  const slash = ref.indexOf('/');
  if (slash < 0) return null;
  return { providerId: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

/** @brief 按 id 找提供商。 */
export function findProvider(config: ModelConfig, providerId: string): ModelProvider | undefined {
  return config.providers.find((provider) => provider.id === providerId);
}

/** @brief 按 id 找提供商，找不到时报错。 */
function requireProvider(config: ModelConfig, providerId: string): ModelProvider {
  const provider = findProvider(config, providerId);
  if (!provider) throw new Error(`${providerId} is not in your model settings`);
  return provider;
}

/**
 * @brief 选择范围是分组、提供商还是模型（§4.2）：等于分组 id 是分组，等于提供商 id 是提供商，含 / 是模型。
 * @param config 当前配置
 * @param pick 选择范围
 */
export function resolvePick(config: ModelConfig, pick: ModelPick): PickTarget {
  const split = splitRef(pick);
  if (split) {
    const provider = findProvider(config, split.providerId);
    const found = provider?.models.some((model) => model.id === split.modelId);
    return provider && found ? { kind: 'model', provider, modelId: split.modelId } : { kind: 'missing' };
  }
  const group = config.groups.find((item) => item.id === pick);
  if (group) return { kind: 'group', group };
  const provider = findProvider(config, pick);
  return provider ? { kind: 'provider', provider } : { kind: 'missing' };
}

/**
 * @brief 模型 <provider>/<model> 在配置里（§5.3 第 1 步）。
 * @param config 当前配置
 * @param ref 模型全名
 */
export function modelExists(config: ModelConfig, ref: ModelRef): boolean {
  return splitRef(ref) !== null && resolvePick(config, ref).kind === 'model';
}

/** @brief 分组成员（提供商 id 或 <provider>/<model>）在配置里。 */
function memberExists(config: ModelConfig, member: string): boolean {
  return splitRef(member) ? modelExists(config, member) : findProvider(config, member) !== undefined;
}

/**
 * @brief 模型所在提供商的区域（§5.3 第 2 步）。
 * @return 区域；区域未确认或模型不在配置里时为 null
 */
export function zoneOfRef(config: ModelConfig, ref: ModelRef): Zone | null {
  const split = splitRef(ref);
  return split ? findProvider(config, split.providerId)?.zone ?? null : null;
}

// ---- 展开（§5.1、§4.3） ----

/** @brief 提供商的全部模型，按列出的顺序。 */
function providerRefs(provider: ModelProvider): ModelRef[] {
  return provider.models.map((model) => `${provider.id}/${model.id}`);
}

/** @brief 一个分组成员展开成的模型：提供商 → 它的全部模型；模型 → 它自己；不存在的提供商 → 无。 */
function memberRefs(config: ModelConfig, member: string): ModelRef[] {
  if (splitRef(member)) return [member];
  const provider = findProvider(config, member);
  return provider ? providerRefs(provider) : [];
}

/**
 * @brief 分组展开：按成员在用户分组里的顺序；项目配置缩小过时只留列出的项，
 *        提供商成员缩小成它的几个模型时按提供商里列出的顺序（§4.3）。
 */
function groupRefs(config: ModelConfig, group: ModelGroup, narrowed: readonly string[] | undefined): ModelRef[] {
  const refs: ModelRef[] = [];
  for (const member of group.members) {
    if (!narrowed || narrowed.includes(member)) refs.push(...memberRefs(config, member));
    else if (!splitRef(member)) refs.push(...memberRefs(config, member).filter((ref) => narrowed.includes(ref)));
  }
  return refs;
}

/**
 * @brief 把选择范围展开成有序的候选（§5.1）：分组 → 成员按顺序（项目配置缩小过的按 §4.3），提供商成员展开成它的全部模型，
 *        模型成员就是它自己；提供商 → 它的模型；模型 → 它自己。同一个模型只保留第一次出现。
 * @param config 当前配置
 * @param pick 选择范围
 * @param project 项目配置（已通过 parseProjectModels）；没有时为 null
 * @return 候选；范围指向的名字不存在时为空数组
 */
export function expandPick(config: ModelConfig, pick: ModelPick, project: ProjectModelsFile | null): ModelRef[] {
  const target = resolvePick(config, pick);
  let refs: ModelRef[] = [];
  if (target.kind === 'group') refs = groupRefs(config, target.group, project?.groups?.[target.group.id]);
  else if (target.kind === 'provider') refs = providerRefs(target.provider);
  else if (target.kind === 'model') refs = [pick];
  return [...new Set(refs)];
}

// ---- 删除的连带改动（§4.1） ----

/** @brief 删除的结果：新配置、确认框列出的连带改动、要删掉密文的 key、被删的模型。 */
export interface CascadeResult {
  /** 删除后的配置 */
  config: ModelConfig;
  /** 确认框逐项列出的连带改动（英文） */
  consequences: string[];
  /** 一起删除的 key 的 ref（调用方删除它们的密文） */
  removedKeyRefs: string[];
  /** 一起删除的模型 <provider>/<model> */
  removedRefs: ModelRef[];
}

/** @brief 从分组里去掉被删的成员；因此变空的分组一起删除。 */
function pruneGroups(config: ModelConfig, gone: (member: string) => boolean): Pick<CascadeResult, 'consequences'>
  & { groups: ModelGroup[]; deletedGroups: string[] } {
  const consequences: string[] = [];
  const deletedGroups: string[] = [];
  const groups: ModelGroup[] = [];
  for (const group of config.groups) {
    const removed = group.members.filter(gone);
    const members = group.members.filter((member) => !gone(member));
    if (removed.length && members.length === 0) {
      deletedGroups.push(group.id);
      consequences.push(`Group ${group.id} has no members left and is deleted.`);
      continue;
    }
    if (removed.length) consequences.push(`Removed from group ${group.id}: ${removed.join(', ')}.`);
    groups.push(removed.length ? { ...group, members } : group);
  }
  return { consequences, deletedGroups, groups };
}

/** @brief normalDefault 指向被删的名字时改为 null。 */
function pruneDefault(config: ModelConfig, goneNames: (name: string) => boolean): {
  normalDefault: ModelPick | null; consequences: string[];
} {
  const pick = config.normalDefault;
  if (pick === null || !goneNames(pick)) return { normalDefault: pick, consequences: [] };
  return { normalDefault: null, consequences: [`The default model range (${pick}) is set to None.`] };
}

/** @brief 删除满足条件的分组成员，并处理变空的分组与 normalDefault。 */
function cascade(config: ModelConfig, gone: (member: string) => boolean,
  goneNames: (name: string) => boolean): { config: ModelConfig; consequences: string[] } {
  const pruned = pruneGroups(config, gone);
  const deleted = new Set(pruned.deletedGroups);
  const defaults = pruneDefault(config, (name) => goneNames(name) || deleted.has(name));
  return {
    config: { ...config, groups: pruned.groups, normalDefault: defaults.normalDefault },
    consequences: [...pruned.consequences, ...defaults.consequences],
  };
}

/** @brief 删提供商的连带改动，不含开头的说明行。 */
function removeProvider(config: ModelConfig, provider: ModelProvider): CascadeResult {
  const prefix = `${provider.id}/`;
  const gone = (name: string): boolean => name === provider.id || name.startsWith(prefix);
  const rest = { ...config, providers: config.providers.filter((item) => item !== provider) };
  const result = cascade(rest, gone, gone);
  return { ...result, removedKeyRefs: provider.keys.map((key) => key.ref), removedRefs: providerRefs(provider) };
}

/**
 * @brief 删除提供商（§4.1）：它和它的模型从所有分组里去掉，它的 key 一起删除；变空的分组删除；
 *        normalDefault 指向被删的名字时改为 null。
 * @param config 当前配置
 * @param providerId 要删的提供商
 */
export function deleteProvider(config: ModelConfig, providerId: string): CascadeResult {
  const provider = requireProvider(config, providerId);
  const result = removeProvider(config, provider);
  const lines = [`Its models are deleted: ${provider.models.map((model) => model.id).join(', ')}.`];
  if (provider.keys.length) {
    lines.push(`Its saved keys are deleted: ${provider.keys.map((key) => key.label).join(', ')}.`);
  }
  return { ...result, consequences: [...lines, ...result.consequences] };
}

/**
 * @brief 删除模型（§4.1）：它从所有分组里去掉；是提供商的最后一个模型时提供商一起删除（同 deleteProvider）；
 *        变空的分组删除；normalDefault 指向被删的名字时改为 null。
 * @param config 当前配置
 * @param providerId 提供商
 * @param modelId 要删的模型
 */
export function deleteModel(config: ModelConfig, providerId: string, modelId: string): CascadeResult {
  const provider = requireProvider(config, providerId);
  const ref = `${provider.id}/${modelId}`;
  if (!provider.models.some((model) => model.id === modelId)) throw new Error(`${ref} is not in your model settings`);
  if (provider.models.length === 1) {
    const result = removeProvider(config, provider);
    const line = `This is the last model of ${provider.name}; the provider and its keys are deleted too.`;
    return { ...result, consequences: [line, ...result.consequences] };
  }
  const models = provider.models.filter((model) => model.id !== modelId);
  const providers = config.providers.map((item) => (item === provider ? { ...provider, models } : item));
  const gone = (name: string): boolean => name === ref;
  const result = cascade({ ...config, providers }, gone, gone);
  return { ...result, removedKeyRefs: [], removedRefs: [ref] };
}

/**
 * @brief 删除分组（§4.1）：normalDefault 指向它时改为 null；确认框说明用到它的会话要重新选范围。
 * @param config 当前配置
 * @param groupId 要删的分组
 */
export function deleteGroup(config: ModelConfig, groupId: string): CascadeResult {
  if (!config.groups.some((group) => group.id === groupId)) throw new Error(`${groupId} is not in your model settings`);
  const groups = config.groups.filter((group) => group.id !== groupId);
  const defaults = pruneDefault(config, (name) => name === groupId);
  return {
    config: { ...config, groups, normalDefault: defaults.normalDefault },
    consequences: ['Sessions using this group will need a new model range.', ...defaults.consequences],
    removedKeyRefs: [],
    removedRefs: [],
  };
}

// ---- 改地址（§4.1） ----

/** @brief 改地址的结果。 */
export interface AddressChange {
  /** 地址的 origin（协议、主机、端口）变了 */
  originChanged: boolean;
  /** 改地址之后的提供商：origin 变了时 key 全部删除（nextKeyNumber 不变） */
  provider: ModelProvider;
  /** 删除的 key 的 ref（调用方删除它们的密文） */
  removedKeyRefs: string[];
  /** 确认框的文字；不需要确认（origin 没变或没有 key）时为 null */
  consequence: string | null;
}

/** @brief 地址的 origin；不是合法 URL 时为 null。 */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * @brief 把提供商的地址改成 baseUrl：origin 变了时删除它的全部 key（key 不会发到新的地址）。
 *        任一地址不是合法 URL 时按 origin 变了处理。
 * @param provider 修改前的提供商
 * @param baseUrl 新地址
 */
export function applyAddressChange(provider: ModelProvider, baseUrl: string): AddressChange {
  const before = originOf(provider.baseUrl);
  const originChanged = before === null || before !== originOf(baseUrl);
  if (!originChanged) {
    return { originChanged, provider: { ...provider, baseUrl }, removedKeyRefs: [], consequence: null };
  }
  const count = provider.keys.length;
  const consequence = count === 0 ? null : addressChangeText(count);
  return {
    originChanged,
    provider: { ...provider, baseUrl, keys: [] },
    removedKeyRefs: provider.keys.map((key) => key.ref),
    consequence,
  };
}

// ---- 项目路径、项目配置与允许的区域（§4.1、§4.3） ----

/**
 * @brief 规范化项目路径（§4.1 projectZones 的键）：全部小写、/ 分隔、无结尾 /，并去掉 . 与 .. 段；
 *        因此路径比较不分大小写（Windows）。
 * @param path 项目文件夹的绝对路径
 */
export function normalizeProjectPath(path: string): string {
  const windows = /^[A-Za-z]:/.test(path) || path.includes('\\');
  let normal = windows ? win32.normalize(path).replace(/\\/g, '/') : posix.normalize(path);
  normal = normal.toLowerCase();
  while (normal.length > 1 && normal.endsWith('/')) normal = normal.slice(0, -1);
  return normal;
}

/** @brief 项目配置的解析结果：没有文件时 file 为 null；无效时是原因或校验原文（拒绝启动卡显示）。 */
export type ProjectConfigParse = { ok: true; file: ProjectModelsFile | null } | { ok: false; error: string };

/** @brief 项目配置列出的一项是否属于用户的这个分组：分组的成员，或某个提供商成员下的模型。 */
function belongsToGroup(config: ModelConfig, group: ModelGroup, item: string): boolean {
  if (group.members.includes(item)) return true;
  const split = splitRef(item);
  return split !== null && group.members.includes(split.providerId) && modelExists(config, item);
}

/** @brief 项目配置的 groups 引用的分组存在、列出的每一项属于这个分组；有错时返回原因。 */
function checkProjectGroups(config: ModelConfig, file: ProjectModelsFile): string | null {
  for (const [groupId, items] of Object.entries(file.groups ?? {})) {
    const group = config.groups.find((item) => item.id === groupId);
    if (!group) return `${groupId} is not in your model settings`;
    const stray = items.find((item) => !belongsToGroup(config, group, item));
    if (stray !== undefined) return `${stray} is not a member of group ${groupId}`;
  }
  return null;
}

/**
 * @brief 解析并校验项目配置（§4.3）：严格校验（只能写 allowedZones 与 groups）、分组存在、列出的项属于用户的分组、
 *        列表不为空。
 * @param text 文件内容；文件不存在时为 null
 * @param config 用户级配置
 */
export function parseProjectModels(text: string | null, config: ModelConfig): ProjectConfigParse {
  if (text === null) return { ok: true, file: null };
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const parsed = ProjectModelsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.map((part) => (typeof part === 'number' ? part : String(part))), message: issue.message }));
    return { ok: false, error: formatIssues(issues) };
  }
  const error = checkProjectGroups(config, parsed.data);
  return error === null ? { ok: true, file: parsed.data } : { ok: false, error };
}

/**
 * @brief 一个项目允许的区域（§4.3）：用户级 allowedZones，加上 projectZones[项目路径]，再与项目配置的 allowedZones
 *        （若写了）取交集。按 local、intranet、public 的顺序。
 * @param config 用户级配置
 * @param projectPath 项目文件夹（任意写法，按 normalizeProjectPath 查授权）
 * @param project 项目配置；没有文件时为 null
 */
export function projectAllowedZones(config: ModelConfig, projectPath: string,
  project: ProjectModelsFile | null): Zone[] {
  const extra = config.projectZones[normalizeProjectPath(projectPath)] ?? [];
  const granted = new Set<Zone>([...config.allowedZones, ...extra]);
  const limit = project?.allowedZones;
  return ZONES.filter((zone) => granted.has(zone) && (!limit || limit.includes(zone)));
}

// ---- 区域建议（§12，规则在 shared/models.ts 的 suggestZone） ----

/**
 * @brief 每个提供商按地址建议的区域（models.get 的 zoneSuggestions）。
 * @param config 当前配置
 */
export function zoneSuggestions(config: ModelConfig): Record<string, Zone> {
  return Object.fromEntries(config.providers.map((provider) => [provider.id, suggestZone(provider.baseUrl)]));
}

// ---- 会话的选择范围（§5.1） ----

/** @brief 决定会话选择范围所需的输入。 */
export interface SessionPickInput {
  /** 当前配置 */
  config: ModelConfig;
  /** 新建的会话 */
  isNew: boolean;
  /** 会话文件里最后一条 mori.pick 的范围；没有时为 null */
  recordedPick: ModelPick | null;
  /** 最后一条助手消息的 <provider>/<model>；没有助手消息时为 null（见 lastAssistantRef） */
  lastAssistantRef: ModelRef | null;
}

/** @brief 会话的选择范围，以及要不要写一条 mori.pick。 */
export interface SessionPick {
  /** 选择范围；没有时为 null（会话按 no_pick 拒绝启动） */
  pick: ModelPick | null;
  /** 要写一条 mori.pick 记下它 */
  record: boolean;
}

/**
 * @brief 会话的选择范围（§5.1）：有 mori.pick 时以最后一条为准；新会话用当时的 normalDefault；
 *        打开没有 mori.pick 的 v0 旧会话时，最后一条助手消息的模型在配置里就用它，否则用 normalDefault。
 *        选出的范围不为 null 且不是已记下的就要写一条。
 * @param input 配置、是否新会话、已记下的范围、最后一条助手消息的模型
 */
export function resolveSessionPick(input: SessionPickInput): SessionPick {
  if (!input.isNew && input.recordedPick !== null) return { pick: input.recordedPick, record: false };
  const last = input.lastAssistantRef;
  const fromHistory = !input.isNew && last !== null && modelExists(input.config, last) ? last : null;
  const pick = fromHistory ?? input.config.normalDefault;
  return { pick, record: pick !== null };
}

/** @brief 会话里一条消息中 lastAssistantRef 用到的字段（pi 的 AgentMessage 的子集）。 */
export interface MessageModelFields {
  /** 角色 */
  role: string;
  /** 助手消息的提供商 */
  provider?: unknown;
  /** 助手消息的模型 id */
  model?: unknown;
}

/**
 * @brief 最后一条助手消息的 <provider>/<model>。
 * @param messages 会话的消息，按时间顺序
 * @return 没有助手消息时为 null
 */
export function lastAssistantRef(messages: readonly MessageModelFields[]): ModelRef | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    if (typeof message.provider === 'string' && typeof message.model === 'string') {
      return `${message.provider}/${message.model}`;
    }
  }
  return null;
}

// ---- 文件读写 ----

/**
 * @brief 原子写 JSON：先写同目录的临时文件再改名（目标被别的进程短暂打开时重试），写到一半不会留下损坏的文件；
 *        失败时删掉临时文件并记录。
 * @param path 目标文件
 * @param value 要写的值
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await renameReplacing(temp, path);
  } catch (error) {
    console.error(`[kernel] cannot write ${path}: ${(error as Error).message}`);
    await rm(temp, { force: true });
    throw error;
  }
}

/** @brief 读 model-config.json 的结果：不存在、读成、或读不出（路径与原文）。 */
export type ConfigLoad =
  | { kind: 'missing' }
  | { kind: 'ok'; config: ModelConfig }
  | { kind: 'invalid'; error: string };

/**
 * @brief 读 model-config.json：不存在时 missing；不是合法 JSON 或校验失败时 invalid（"<路径>: <原文>"），文件不动（§4.1）。
 * @param path 文件路径
 * @param reserved 保留 id
 */
export async function readModelConfig(path: string, reserved: readonly string[]): Promise<ConfigLoad> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    console.error(`[kernel] cannot read ${path}: ${(error as Error).message}`);
    return { kind: 'invalid', error: `${path}: ${(error as Error).message}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    console.error(`[kernel] cannot parse ${path}: ${(error as Error).message}`);
    return { kind: 'invalid', error: `${path}: ${(error as Error).message}` };
  }
  const parsed = parseModelConfig(raw, { reserved });
  if (parsed.ok) return { kind: 'ok', config: parsed.config };
  const message = formatIssues(parsed.issues);
  console.error(`[kernel] invalid ${path}: ${message}`);
  return { kind: 'invalid', error: `${path}: ${message}` };
}

/**
 * @brief 校验后原子写 model-config.json；校验失败时不写，抛出带位置的错误。
 * @param path 文件路径
 * @param config 要写的配置
 * @param options 保留 id 与保存前的配置（检查 nextKeyNumber 只增不减）
 */
export async function saveModelConfig(path: string, config: ModelConfig, options: ValidateOptions): Promise<void> {
  const parsed = parseModelConfig(config, options);
  if (!parsed.ok) {
    const message = formatIssues(parsed.issues);
    console.error(`[kernel] refusing to save ${path}: ${message}`);
    throw new Error(message);
  }
  await writeJsonAtomic(path, parsed.config);
}

/**
 * @brief 读项目配置 <project>/.mori/models.json 并校验（§4.3）：不存在时 file 为 null；读不出、坏 JSON、校验失败时给出原因。
 * @param projectDir 项目文件夹
 * @param config 用户级配置
 */
export async function readProjectModels(projectDir: string, config: ModelConfig): Promise<ProjectConfigParse> {
  const path = join(projectDir, PROJECT_MODELS_FILE);
  let text: string | null;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[kernel] cannot read ${path}: ${(error as Error).message}`);
      return { ok: false, error: (error as Error).message };
    }
    text = null;
  }
  const result = parseProjectModels(text, config);
  if (!result.ok) console.error(`[kernel] invalid ${path}: ${result.error}`);
  return result;
}
