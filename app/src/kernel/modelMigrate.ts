// 第一次启动时从 v0 的 <agentDir>/models.json 迁移到 model-config.json（docs/specs/model-providers.md §4.5）。
// migrateV0Models 是纯函数：输入 models.json 的文本、已有密文的 ref、pi 设置与保留 id，给出配置、迁移说明、
// 要加密的明文 key 和要复制的按模型思考强度；runMigration 读写文件，加密 key 由调用方注入（只有主进程能加密）。

import { access, readFile } from 'node:fs/promises';
import {
  API_TYPES, COMPAT_OPTIONS, ID_PATTERN, MODEL_LIMITS, ProviderKeySchema, ProviderModelSchema,
  ProviderSchema, type ApiType, type Compat, type MigrationNotice, type ModelConfig, type ModelProvider,
  type ProviderKey, type ProviderModel,
} from '../shared/models';
import { formatIssues, generateId, parseModelConfig, writeJsonAtomic, type ConfigIssue } from './modelConfig';

/** @brief models.json 的模型没写 contextWindow 时 pi 用的值（§4.5、§12）。 */
export const PI_DEFAULT_CONTEXT_WINDOW = 128_000;
/** @brief models.json 的模型没写 maxTokens 时 pi 用的值（§4.5、§12）。 */
export const PI_DEFAULT_MAX_TOKENS = 16_384;

/** 字符串字面量或 // 行注释；照搬 pi 1.3.0 stripJsonComments（dist/utils/json.js）的第一个正则，同 config.ts */
const LINE_COMMENT = /"(?:\\.|[^"\\])*"|\/\/[^\n]*/g;
/** 字符串字面量或 } ] 前多余的逗号；同上的第二个正则 */
const TRAILING_COMMA = /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g;

type JsonObject = Record<string, unknown>;

/** @brief 迁移要读的 pi 设置（settings.json 的三项）。 */
export interface PiSettingsView {
  /** 默认模型的提供商 */
  defaultProvider?: unknown;
  /** 默认模型的 id */
  defaultModel?: unknown;
  /** 按模型的新会话思考强度："<provider>/<model>" → 强度 */
  modelThinkingLevels?: unknown;
}

/** @brief 纯迁移的输入。 */
export interface MigrationInput {
  /** models.json 的文本 */
  text: string;
  /** models.json 的路径，只用于错误文字 */
  source: string;
  /** credentials.json 里已有密文的 ref（不论解没解开） */
  credentialRefs: readonly string[];
  /** 其中有密文却解不开的 ref：沿用这个 key，同时在说明里列为要重新填写 */
  unreadableRefs: readonly string[];
  /** pi 设置 */
  settings: PiSettingsView;
  /** 保留 id（mori 与 pi 内置的提供商 id） */
  reserved: readonly string[];
  /** 迁移的时刻（ms），写进说明 */
  now: number;
}

/** @brief 要交给主进程加密保存的明文 key（models.json 里手写的）。 */
export interface KeyToEncrypt {
  /** 存成的 ref */
  ref: string;
  /** 明文；只在内存里交给主进程 */
  secret: string;
}

/** @brief 要在 pi 设置的 modelThinkingLevels 里复制的一项（旧键不删）。 */
export interface ThinkingCopy {
  /** 旧键 "<v0 provider id>/<model>" */
  from: string;
  /** 新键 "<改写后的 id>/<model>" */
  to: string;
}

/**
 * @brief 纯迁移的结果：没有 provider（按首次启动处理）、迁移成、或失败（读不出 models.json，或没有一个 provider
 *        能迁移；都按首次启动处理，error 显示在首次启动表单上方）。
 */
export type MigrationResult =
  | { kind: 'empty' }
  | {
    kind: 'migrated';
    /** 迁移成的配置 */
    config: ModelConfig;
    /** 迁移说明（model-migration.json） */
    notice: MigrationNotice;
    /** 要加密保存的明文 key */
    keysToEncrypt: KeyToEncrypt[];
    /** 要复制的思考强度键 */
    thinkingCopies: ThinkingCopy[];
  }
  | { kind: 'failed'; error: string };

/**
 * @brief 用 v0 的读法解析 models.json（同 pi：去 BOM、// 注释和 } ] 前多余的逗号）。
 * @param text 文件内容
 * @param source 文件路径，用于错误文字
 * @throws 解析失败时报错 "Cannot parse <路径>: not valid JSON (at position N (line L column C))"，
 *         不带文件内容（key 可能在其中，MP-26）
 */
export function parseV0Models(text: string, source: string): unknown {
  const uncommented = text.replace(/^\uFEFF/, '').replace(LINE_COMMENT, (match) => (match[0] === '"' ? match : ''));
  const cleaned = uncommented.replace(TRAILING_COMMA,
    (match, tail?: string) => tail ?? (match[0] === '"' ? match : ''));
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    // V8 的消息会带出出错位置附近的原文片段，可能是明文 key：只保留位置
    const at = /at position \d+(?: \(line \d+ column \d+\))?/.exec((error as Error).message);
    throw new Error(`Cannot parse ${source}: not valid JSON${at ? ` (${at[0]})` : ''}`);
  }
}

/** @brief 是普通对象（不是数组、null）。 */
function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @brief zod 的错误写成一行。 */
function zodText(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  const located: ConfigIssue[] = issues.map((issue) => ({
    path: issue.path.map((part) => (typeof part === 'number' ? part : String(part))), message: issue.message }));
  return formatIssues(located);
}

/** @brief 迁移中累积的说明。 */
interface NoticeParts {
  /** 丢弃的内容 */
  dropped: MigrationNotice['dropped'];
  /** 要重新填写 key 的提供商 id */
  reenterKeys: string[];
  /** 以密文为准的提供商 id */
  keptCiphertext: string[];
}

/** @brief 只保留 v0 勾选时写的那个值（§4.5），别的值和其余字段丢弃并列出。 */
function migrateCompat(v0Id: string, compat: unknown, notes: NoticeParts): Compat {
  const kept: Record<string, unknown> = {};
  if (compat === undefined) return kept;
  if (!isObject(compat)) {
    notes.dropped.push({ subject: `${v0Id} compat`, reason: 'compat is not an object' });
    return kept;
  }
  for (const [field, value] of Object.entries(compat)) {
    const option = COMPAT_OPTIONS.find((item) => item.field === field);
    if (option && option.value === value) kept[field] = value;
    else {
      const reason = option ? `value ${JSON.stringify(value)} is not supported` : 'not a supported compat option';
      notes.dropped.push({ subject: `${v0Id} compat.${field}`, reason });
    }
  }
  return kept as Compat;
}

/** @brief 一个 v0 模型按 §4.5 改写；不合格时返回原因。 */
function migrateModel(raw: unknown): ProviderModel | string {
  if (!isObject(raw)) return 'model is not an object';
  const contextWindow = raw.contextWindow ?? PI_DEFAULT_CONTEXT_WINDOW;
  let maxTokens = raw.maxTokens ?? PI_DEFAULT_MAX_TOKENS;
  if (typeof contextWindow === 'number' && typeof maxTokens === 'number' && maxTokens >= contextWindow) {
    maxTokens = Math.floor(contextWindow / 2);
  }
  const parsed = ProviderModelSchema.safeParse({
    id: raw.id, family: '', contextWindow, maxTokens, reasoning: raw.reasoning ?? false, input: raw.input ?? ['text'],
  });
  return parsed.success ? parsed.data : zodText(parsed.error.issues);
}

/** @brief provider 下合格的模型，按原顺序；不合格的和重复的丢弃并列出。 */
function migrateModelList(v0Id: string, models: unknown, notes: NoticeParts): ProviderModel[] {
  const kept: ProviderModel[] = [];
  const list = Array.isArray(models) ? models : [];
  list.forEach((raw, index) => {
    const name = isObject(raw) && typeof raw.id === 'string' ? raw.id : `#${index + 1}`;
    const model = migrateModel(raw);
    let reason = typeof model === 'string' ? model : null;
    if (typeof model !== 'string' && kept.some((item) => item.id === model.id)) reason = 'duplicate model id';
    if (reason !== null) notes.dropped.push({ subject: `${v0Id}/${name}`, reason });
    else kept.push(model as ProviderModel);
  });
  return kept;
}

/** @brief 迁移中的提供商：还没有定下 id 和 key。 */
interface Draft {
  /** v0 的 provider id */
  v0Id: string;
  /** provider 原文 */
  raw: JsonObject;
  /** 除 id、keys、nextKeyNumber 之外的字段 */
  fields: Omit<ModelProvider, 'id' | 'keys' | 'nextKeyNumber'>;
}

/** @brief 一个 v0 provider 的字段（除 id 和 key）；不迁移时把原因记进说明并返回 null。 */
function draftProvider(v0Id: string, raw: unknown, notes: NoticeParts): Draft | null {
  const drop = (reason: string): null => {
    notes.dropped.push({ subject: v0Id, reason });
    return null;
  };
  if (!isObject(raw)) return drop('provider is not an object');
  if (!API_TYPES.includes(raw.api as ApiType)) {
    return drop(`API type ${JSON.stringify(raw.api ?? null)} is not supported`);
  }
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : v0Id;
  const models = migrateModelList(v0Id, raw.models, notes);
  if (models.length === 0) return drop('no usable models');
  const fields = { name, api: raw.api as ApiType, baseUrl: raw.baseUrl as string,
    compat: migrateCompat(v0Id, raw.compat, notes), concurrency: MODEL_LIMITS.concurrencyDefault, models };
  const check = ProviderSchema.safeParse({ ...fields, id: 'migrating', keys: [], nextKeyNumber: 1 });
  return check.success ? { v0Id, raw, fields } : drop(zodText(check.error.issues));
}

/**
 * @brief 给迁入的提供商定 id：合格且不是保留 id 的不变；其余按 §4.1 改写（没有字母数字时为 provider，冲突加 -2、-3），
 *        先让不变的占住名字。
 */
function assignIds(drafts: Draft[], reserved: readonly string[]): Map<Draft, string> {
  const keep = (id: string): boolean => ID_PATTERN.test(id) && !reserved.includes(id);
  const taken = new Set([...reserved, ...drafts.map((draft) => draft.v0Id).filter(keep)]);
  const ids = new Map<Draft, string>();
  for (const draft of drafts) {
    const id = keep(draft.v0Id) ? draft.v0Id : generateId(draft.v0Id, taken);
    taken.add(id);
    ids.set(draft, id);
  }
  return ids;
}

/** @brief credentials.json 里的 ref：有密文的、其中解不开的。 */
interface KeyRefs {
  /** 有密文的 ref */
  credential: ReadonlySet<string>;
  /** 有密文却解不开的 ref */
  unreadable: ReadonlySet<string>;
}

/** @brief key 的去向：沿用密文、加密明文、要重新填写，或没有 key。 */
interface KeyPlan {
  /** 配置里的 key */
  keys: ProviderKey[];
  /** 要加密的明文 */
  encrypt: KeyToEncrypt | null;
}

/**
 * @brief 一个提供商的 key（§4.5）：ref 沿用 v0 的 id（不能作 ref 时用新 id）；有同 ref 的密文时以密文为准
 *        （密文解不开时仍沿用，并列为要重新填写）；手写的明文交给主进程加密；$ 开头的环境变量写法不迁移、列为要重新填写。
 */
function planKey(draft: Draft, id: string, refs: KeyRefs, notes: NoticeParts): KeyPlan {
  const ref = ProviderKeySchema.shape.ref.safeParse(draft.v0Id).success ? draft.v0Id : id;
  const key: ProviderKey = { ref, label: 'Key 1' };
  const apiKey = typeof draft.raw.apiKey === 'string' && draft.raw.apiKey ? draft.raw.apiKey : null;
  if (refs.credential.has(ref)) {
    if (apiKey !== null && !apiKey.startsWith('$')) notes.keptCiphertext.push(id);
    if (refs.unreadable.has(ref)) notes.reenterKeys.push(id);
    return { keys: [key], encrypt: null };
  }
  if (apiKey === null) return { keys: [], encrypt: null };
  if (apiKey.startsWith('$')) {
    notes.reenterKeys.push(id);
    return { keys: [], encrypt: null };
  }
  return { keys: [key], encrypt: { ref, secret: apiKey } };
}

/** @brief pi 设置的默认模型按改写后的 id 成为 normalDefault；找不到时为 null。 */
function migrateDefault(settings: PiSettingsView, providers: Map<string, ModelProvider>): string | null {
  const { defaultProvider, defaultModel } = settings;
  if (typeof defaultProvider !== 'string' || typeof defaultModel !== 'string') return null;
  const provider = providers.get(defaultProvider);
  if (!provider?.models.some((model) => model.id === defaultModel)) return null;
  return `${provider.id}/${defaultModel}`;
}

/** @brief 改写了 id 的提供商，把 modelThinkingLevels 的旧键复制到新键（只复制有值的键）。 */
function thinkingCopies(settings: PiSettingsView, providers: Map<string, ModelProvider>): ThinkingCopy[] {
  const levels = isObject(settings.modelThinkingLevels) ? settings.modelThinkingLevels : {};
  const copies: ThinkingCopy[] = [];
  for (const [v0Id, provider] of providers) {
    if (v0Id === provider.id) continue;
    for (const model of provider.models) {
      const from = `${v0Id}/${model.id}`;
      if (from in levels) copies.push({ from, to: `${provider.id}/${model.id}` });
    }
  }
  return copies;
}

/** @brief models.json 的 providers；没有或为空时为 null，形状不对时报错。 */
function providerEntries(file: unknown, source: string): [string, unknown][] | null {
  if (!isObject(file)) throw new Error(`Cannot migrate ${source}: the file is not a JSON object`);
  if (file.providers === undefined || file.providers === null) return null;
  if (!isObject(file.providers)) throw new Error(`Cannot migrate ${source}: providers is not an object`);
  const entries = Object.entries(file.providers);
  return entries.length ? entries : null;
}

/** @brief 迁入全部 provider：定 id、定 key，返回 v0 id → 提供商，以及要加密的 key。 */
function buildProviders(entries: [string, unknown][], input: MigrationInput, notes: NoticeParts): {
  providers: Map<string, ModelProvider>; keysToEncrypt: KeyToEncrypt[];
} {
  const drafts = entries.map(([v0Id, raw]) => draftProvider(v0Id, raw, notes))
    .filter((draft): draft is Draft => draft !== null);
  const ids = assignIds(drafts, input.reserved);
  const refs: KeyRefs = { credential: new Set(input.credentialRefs), unreadable: new Set(input.unreadableRefs) };
  const providers = new Map<string, ModelProvider>();
  const keysToEncrypt: KeyToEncrypt[] = [];
  for (const [draft, id] of ids) {
    const plan = planKey(draft, id, refs, notes);
    if (plan.encrypt) keysToEncrypt.push(plan.encrypt);
    providers.set(draft.v0Id, { id, ...draft.fields, keys: plan.keys, nextKeyNumber: 1 });
  }
  return { providers, keysToEncrypt };
}

/**
 * @brief 没有一个 provider 能迁移时的说明（§4.5：作为 migrationError 显示在首次启动表单上方）：每个丢弃的对象与原因。
 * @param source models.json 的路径
 * @param notes 迁移中累积的说明
 */
function noneMigratedText(source: string, notes: NoticeParts): string {
  const dropped = notes.dropped.map((item) => `${item.subject}: ${item.reason}`).join('; ');
  return `No provider in ${source} could be migrated: ${dropped}`;
}

/**
 * @brief 从 v0 的 models.json 迁移（§4.5），纯函数。
 * @param input models.json 的文本、已有密文的 ref、pi 设置、保留 id、时刻
 * @return providers 为空或没有时 empty；读不出、或没有一个 provider 能迁移时 failed（原文或迁移说明）；
 *         否则配置、说明、要加密的 key 与要复制的思考强度键
 */
export function migrateV0Models(input: MigrationInput): MigrationResult {
  let entries: [string, unknown][] | null;
  try {
    entries = providerEntries(parseV0Models(input.text, input.source), input.source);
  } catch (error) {
    return { kind: 'failed', error: (error as Error).message };
  }
  if (entries === null) return { kind: 'empty' };
  const notes: NoticeParts = { dropped: [], reenterKeys: [], keptCiphertext: [] };
  const { providers, keysToEncrypt } = buildProviders(entries, input, notes);
  if (providers.size === 0) return { kind: 'failed', error: noneMigratedText(input.source, notes) };
  const config: ModelConfig = {
    version: 1, providers: [...providers.values()], groups: [],
    normalDefault: migrateDefault(input.settings, providers),
  };
  const checked = parseModelConfig(config, { reserved: input.reserved });
  if (!checked.ok) return { kind: 'failed', error: `Cannot migrate ${input.source}: ${formatIssues(checked.issues)}` };
  const notice: MigrationNotice = {
    at: input.now,
    providers: [...providers].map(([from, provider]) => ({ from, id: provider.id, name: provider.name })),
    ...notes,
  };
  return { kind: 'migrated', config, notice, keysToEncrypt, thinkingCopies: thinkingCopies(input.settings, providers) };
}

// ---- 读写文件 ----

/** @brief runMigration 的输入：文件位置、迁移所需的数据与注入的操作。 */
export interface MigrationIo {
  /** <agentDir>/models.json */
  modelsPath: string;
  /** <userData>/model-config.json */
  configPath: string;
  /** <userData>/model-migration.json */
  noticePath: string;
  /** 迁移的数据（文本由 runMigration 读） */
  data: Omit<MigrationInput, 'text' | 'source'>;
  /**
   * @brief 请主进程加密保存一个 key。
   * @param ref 存成的 ref
   * @param secret 明文
   */
  encryptKey(ref: string, secret: string): Promise<void>;
  /**
   * @brief 写 JSON 文件；省略时用 writeJsonAtomic。
   * @param path 文件路径
   * @param value 内容
   */
  writeJson?(path: string, value: unknown): Promise<void>;
}

/** @brief runMigration 的结果。 */
export type MigrationRun =
  | { kind: 'skipped' }
  | { kind: 'empty' }
  | { kind: 'failed'; error: string }
  | {
    kind: 'migrated';
    /** 迁移成的配置（已写入） */
    config: ModelConfig;
    /** 迁移说明 */
    notice: MigrationNotice;
    /** 调用方要在 pi 设置里复制的思考强度键 */
    thinkingCopies: ThinkingCopy[];
    /** 写迁移说明失败时的原文（配置已写入，迁移仍算成功）；没有时为 null */
    noticeError: string | null;
  };

/** @brief 文件存在。 */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** @brief 读 models.json；不存在时为 null。 */
async function readModelsText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`);
  }
}

/** @brief 加密全部明文 key；任何一个失败就报错（不写配置）。 */
async function encryptAll(io: MigrationIo, keys: readonly KeyToEncrypt[]): Promise<void> {
  for (const key of keys) {
    try {
      await io.encryptKey(key.ref, key.secret);
    } catch (error) {
      throw new Error(`Cannot save the API key ${key.ref}: ${(error as Error).message}`);
    }
  }
}

/** @brief 写迁移说明；失败时记录并返回原文。 */
async function writeNotice(io: MigrationIo, notice: MigrationNotice): Promise<string | null> {
  try {
    await (io.writeJson ?? writeJsonAtomic)(io.noticePath, notice);
    return null;
  } catch (error) {
    const message = `Cannot write ${io.noticePath}: ${(error as Error).message}`;
    console.error(`[kernel] ${message}`);
    return message;
  }
}

/**
 * @brief 后台进程启动时迁移一次（§4.5）：model-config.json 已存在时跳过；models.json 不存在或没有 provider 时 empty
 *        （按首次启动处理）；读不出、没有一个 provider 能迁移、任何一个明文 key 加密失败、写配置失败时 failed，
 *        不写 model-config.json。
 *        成功时先写 model-config.json，再写 model-migration.json。
 * @param io 文件位置、迁移数据与注入的操作
 */
export async function runMigration(io: MigrationIo): Promise<MigrationRun> {
  if (await exists(io.configPath)) return { kind: 'skipped' };
  try {
    const text = await readModelsText(io.modelsPath);
    if (text === null) return { kind: 'empty' };
    const result = migrateV0Models({ ...io.data, text, source: io.modelsPath });
    if (result.kind !== 'migrated') {
      if (result.kind === 'failed') console.error(`[kernel] migration failed: ${result.error}`);
      return result;
    }
    await encryptAll(io, result.keysToEncrypt);
    await (io.writeJson ?? writeJsonAtomic)(io.configPath, result.config);
    const noticeError = await writeNotice(io, result.notice);
    return { kind: 'migrated', config: result.config, notice: result.notice, thinkingCopies: result.thinkingCopies,
      noticeError };
  } catch (error) {
    console.error(`[kernel] migration failed: ${(error as Error).message}`);
    return { kind: 'failed', error: (error as Error).message };
  }
}
