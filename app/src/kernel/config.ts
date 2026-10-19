// 读写 pi 自己的 models.json 与默认模型，并通过 pi 的 ModelRuntime 测试连接。
// API key 不写进 models.json：由主进程加密保存，pi 只在内存里持有（runtime API key）。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Connection, SavedConnection, TestResult } from '../shared/protocol';
import { requestStoreKey } from './credentials';
import { getRuntime, globalSettings } from './pi';

/** Mori 在 models.json 中使用的 provider id */
export const PROVIDER_ID = 'mori-endpoint';

/** 测试连接的上限，见 docs/v0/defaults.md */
const TEST_TIMEOUT_MS = 30_000;
const TEST_MAX_TOKENS = 512;

type JsonObject = Record<string, unknown>;
type ModelsFile = JsonObject & { providers?: Record<string, JsonObject> };

/** @brief 读取 models.json；文件不存在时返回空对象，无法解析时报错且不改动文件。 */
async function readModelsFile(path: string): Promise<ModelsFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  try {
    return JSON.parse(text.replace(/^﻿/, '')) as ModelsFile;
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${(error as Error).message}`);
  }
}

/** @brief 先写临时文件再改名，避免写到一半留下损坏的 models.json。 */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

/** @brief pi 内存里是否有这个 provider 的 key。 */
function hasKey(runtime: ModelRuntime): boolean {
  return runtime.getProviderAuthStatus(PROVIDER_ID).source === 'runtime';
}

/** @brief 从 models.json 中取出 Mori 保存的连接；key 不回传，只说明是否已保存。 */
export async function readConnection(agentDir: string): Promise<SavedConnection | null> {
  const file = await readModelsFile(join(agentDir, 'models.json'));
  const provider = file.providers?.[PROVIDER_ID];
  const model = (provider?.models as JsonObject[] | undefined)?.[0];
  if (!provider || !model) return null;
  return {
    keySaved: hasKey(await getRuntime()),
    connection: {
      name: String(provider.name ?? PROVIDER_ID),
      baseUrl: String(provider.baseUrl ?? ''),
      apiKey: '',
      modelId: String(model.id ?? ''),
      contextWindow: Number(model.contextWindow ?? 128000),
    },
  };
}

/** @brief 把连接合并进 models.json 的 Mori provider：保留手写的 compat、headers 等字段和其他模型，去掉 apiKey 字段。 */
async function writeConnection(path: string, file: ModelsFile, connection: Connection): Promise<void> {
  const { apiKey: _droppedKey, ...previous } = file.providers?.[PROVIDER_ID] ?? {};
  const previousModels = (previous.models as JsonObject[] | undefined) ?? [];
  const previousModel = previousModels.find((model) => model.id === connection.modelId) ?? {};
  const model = { ...previousModel, id: connection.modelId, name: previousModel.name ?? connection.modelId,
    contextWindow: connection.contextWindow };
  file.providers = {
    ...file.providers,
    [PROVIDER_ID]: {
      ...previous,
      name: connection.name,
      baseUrl: connection.baseUrl,
      api: previous.api ?? 'openai-completions',
      models: [model, ...previousModels.filter((item) => item.id !== connection.modelId)],
    },
  };
  await writeJsonAtomic(path, file);
}

/** @brief 没填 key 时只允许沿用已保存的 key，而且服务地址的 origin 不能变。 */
function requireReusableKey(runtime: ModelRuntime, previousBaseUrl: unknown, baseUrl: string): void {
  const previousOrigin = previousBaseUrl ? new URL(String(previousBaseUrl)).origin : null;
  if (!hasKey(runtime) || previousOrigin !== new URL(baseUrl).origin) {
    throw new Error('API key is required when the service address changes');
  }
}

/** @brief 保存连接：先加密保存 key，再写 models.json、交给 pi，最后设为默认模型。返回 pi 报告的配置错误。 */
export async function saveConnection(agentDir: string, connection: Connection): Promise<string | null> {
  const runtime = await getRuntime();
  const path = join(agentDir, 'models.json');
  const file = await readModelsFile(path);
  if (connection.apiKey) await requestStoreKey(PROVIDER_ID, connection.apiKey);
  else requireReusableKey(runtime, file.providers?.[PROVIDER_ID]?.baseUrl, connection.baseUrl);
  await writeConnection(path, file, connection);
  await runtime.refresh({ allowNetwork: false });
  if (connection.apiKey) await runtime.setRuntimeApiKey(PROVIDER_ID, connection.apiKey);
  const settings = await globalSettings();
  settings.setDefaultModelAndProvider(PROVIDER_ID, connection.modelId);
  await settings.flush();
  const settingsErrors = settings.drainErrors().map((item) => item.error.message);
  return [runtime.getError(), ...settingsErrors].filter(Boolean).join('; ') || null;
}

/** @brief 用默认模型发一条短消息，记录到第一个增量（正文或思考）的时间。 */
export async function testConnection(): Promise<TestResult> {
  const started = Date.now();
  const runtime = await getRuntime();
  const settings = await globalSettings();
  const provider = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  const result: TestResult = { ok: false, firstTokenMs: null, totalMs: 0, text: '', thinking: false, error: null };
  if (!provider || !modelId) return { ...result, error: 'No connection saved yet; save the connection first' };
  const model = runtime.getModel(provider, modelId);
  if (!model) {
    return { ...result, error: runtime.getError() ?? `Model ${provider}/${modelId} not found in models.json` };
  }
  const message = { role: 'user' as const, content: 'Reply with one short sentence.', timestamp: started };
  const context = { messages: [message] };
  const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
  try {
    for await (const event of runtime.streamSimple(model, context, { maxTokens: TEST_MAX_TOKENS, signal })) {
      if (event.type === 'text_delta' || event.type === 'thinking_delta') result.firstTokenMs ??= Date.now() - started;
      if (event.type === 'text_delta') result.text += event.delta;
      if (event.type === 'thinking_delta') result.thinking = true;
      if (event.type === 'error') result.error = event.error.errorMessage ?? 'Request failed';
    }
  } catch (error) {
    result.error = (error as Error).message;
  }
  if (signal.aborted) result.error = `No response within ${TEST_TIMEOUT_MS / 1000} seconds`;
  if (result.error) console.error(`[kernel] connection test failed: ${result.error}`);
  const ok = result.error === null && (result.text.length > 0 || result.thinking);
  return { ...result, ok, totalMs: Date.now() - started, text: result.text.slice(0, 200) };
}
