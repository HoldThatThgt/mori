// pi 设置的读写与测试连接（docs/specs/model-providers.md §9.4、§9.1）。
// 模型配置不在这里：model-config.json 由模型层（modelLayer.ts、modelCommands.ts）读写，v0 的 models.json 不再读写。
// 这里只留：config.get 的内容（pi 设置的错误与 defaultThinkingLevel、首次启动、迁移与配置的错误）、
// 按模型的新会话思考强度（pi 设置的 modelThinkingLevels，沿用 v0），以及经模型池的测试连接。

import type { ConfigInfo, ThinkingLevel } from '../shared/models';
import type { Command, TestResult } from '../shared/protocol';
import { getModelLayer } from './modelLayer';
import type { AttemptRecord } from './modelTypes';
import { globalSettings } from './pi';

/** 设置里没有全局的思考强度时 pi 用的值（core/defaults.js DEFAULT_THINKING_LEVEL） */
const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';
/** 测试连接的最大输出（沿用 v0，见 docs/v0/defaults.md） */
const TEST_MAX_TOKENS = 512;
/**
 * 测试连接对勾了 Supports thinking 的模型用的思考强度（§7.7、§12“测试连接的思考强度”）：同探针第 1 步，
 * 第一次探测之前也不发“关闭思考”；没勾的模型不带
 */
const TEST_REASONING = 'medium' satisfies ThinkingLevel;
/** 测试连接回复的开头最多显示的字符数（§9.1） */
const TEST_REPLY_CHARS = 200;
/** pi 表示“不限时”的 timeoutMs：排队与重试的时限由模型池执行，首个内容的时限由这里执行（§8.4、§11.6 K11） */
const NO_TIMEOUT_MS = 2147483647;

/** @brief connection.test 的参数。 */
export type TestRequest = Extract<Command, { type: 'connection.test' }>;

/** 正在进行的测试连接；你点"Cancel"时中止它 */
let runningTest: AbortController | null = null;

/** @brief pi 读设置文件时报告的错误（带文件路径），有时记录；没有时为 null。 */
function settingsLoadError(settings: Awaited<ReturnType<typeof globalSettings>>): string | null {
  const errors = settings.drainErrors().map((item) => `${item.path ?? item.scope}: ${item.error.message}`);
  if (errors.length === 0) return null;
  console.error(`[kernel] cannot read pi settings: ${errors.join('; ')}`);
  return errors.join('; ');
}

/**
 * @brief config.get（§9.4）：pi 的配置目录、pi 设置的错误与 defaultThinkingLevel，以及模型层的首次启动、
 *        迁移失败、配置读不出与这次启动是否刚迁移完。
 * @param agentDir pi 的配置目录
 */
export async function readConfig(agentDir: string): Promise<ConfigInfo> {
  const layer = await getModelLayer();
  const settings = await globalSettings();
  return {
    agentDir,
    settingsError: settingsLoadError(settings),
    defaultThinkingLevel: (settings.getDefaultThinkingLevel() as ThinkingLevel | undefined) ?? DEFAULT_THINKING_LEVEL,
    firstRun: layer.isFirstRun(),
    migrationError: layer.isFirstRun() ? layer.migrationError() : null,
    configError: layer.configError(),
    migratedNow: layer.isMigratedNow(),
  };
}

/**
 * @brief 新会话默认的思考强度（沿用 v0）：level 不为 null 时写 pi 设置的 modelThinkingLevels["<provider>/<model>"]，
 *        为 null 时删掉这一项（模型不支持思考）。
 * @param providerId 提供商 id
 * @param modelId 模型 id
 * @param level 强度；null 表示删掉
 * @return pi 写设置时报告的错误；没有时为 null
 */
export async function setModelThinkingLevel(providerId: string, modelId: string,
  level: ThinkingLevel | null): Promise<string | null> {
  const settings = await globalSettings();
  if (level === null) settings.removeModelThinkingLevel(providerId, modelId);
  else settings.setModelThinkingLevel(providerId, modelId, level);
  await settings.flush();
  const errors = settings.drainErrors().map((item) => item.error.message);
  if (errors.length === 0) return null;
  console.error(`[kernel] cannot save the thinking level of ${providerId}/${modelId}: ${errors.join('; ')}`);
  return errors.join('; ');
}

/**
 * @brief 首个内容的时限：每次真正发出时重新计时，收到内容后停止；超时中止这次尝试（§5.4 timeout）。ms 是这个模型按
 *        模型学的时限（§7.8），sentAt 记最后一次真正发出的时刻。
 */
function firstContentWatch(ms: number, attempt: AbortController) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watch = {
    ms,
    timedOut: false,
    sentAt: null as number | null,
    arm: () => {
      clearTimeout(timer);
      watch.sentAt = Date.now();
      timer = setTimeout(() => {
        watch.timedOut = true;
        attempt.abort();
      }, ms);
    },
    clear: () => clearTimeout(timer),
  };
  return watch;
}

/** @brief 测试连接用到的流与选项。 */
interface TestRun {
  /** 测试开始的时刻 */
  started: number;
  /** 测的模型 <provider>/<model> */
  ref: string;
  /** 从最后一次真正发出到首个内容的用时（§7.8，记进这个模型的时限）；还没收到时为 null */
  sentToFirstMs: number | null;
  /** 你点"Cancel"的控制器 */
  controller: AbortController;
  /** 首个内容的时限 */
  watch: ReturnType<typeof firstContentWatch>;
  /** 模型池记下的最后一次尝试 */
  record: AttemptRecord | null;
}

/** @brief 读完测试的事件流，记下首字时间、正文与是否有思考；出错的原文写进 result.error。 */
async function drainTest(stream: AsyncIterable<{ type: string; delta?: string; error?: { errorMessage?: string } }>,
  run: TestRun, result: TestResult): Promise<void> {
  for await (const event of stream) {
    if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_start') {
      run.watch.clear();
      if (result.firstTokenMs === null && run.watch.sentAt !== null) run.sentToFirstMs = Date.now() - run.watch.sentAt;
      result.firstTokenMs ??= Date.now() - run.started;
    }
    if (event.type === 'text_delta') result.text += event.delta ?? '';
    if (event.type === 'thinking_delta') result.thinking = true;
    if (event.type === 'error') result.error = event.error?.errorMessage ?? 'Request failed';
  }
}

/**
 * @brief 整理测试结果：取消、超时、成功；首个内容的用时或超时记进这个模型的时限（§7.8）；成功时清除用到的 key 的
 *        不可用记录，以及提供商的 connection、这个模型的 not_found（§8.3 的 2026-10-26 补），并通知会话重新校验。
 */
async function finishTest(request: TestRequest, run: TestRun, result: TestResult): Promise<TestResult> {
  const layer = await getModelLayer();
  result.cancelled = run.controller.signal.aborted;
  if (run.sentToFirstMs !== null) layer.recordFirstToken(run.ref, run.sentToFirstMs);
  if (result.cancelled) result.error = 'Cancelled';
  else if (run.watch.timedOut && result.firstTokenMs === null) {
    layer.recordFirstTokenTimeout(run.ref, run.watch.ms);
    result.error = `No response within ${run.watch.ms / 1000} s`;
  }
  if (result.error && !result.cancelled) console.error(`[kernel] connection test failed: ${result.error}`);
  const ok = result.error === null && (result.text.length > 0 || result.thinking);
  if (ok) {
    const keyRef = request.keyRef ?? run.record?.keyRef ?? null;
    layer.getPool().clearAfterTest(`${request.providerId}/${request.modelId}`, keyRef);
    layer.notify({ kind: 'keys' });
  }
  return { ...result, ok, totalMs: Date.now() - run.started, text: result.text.slice(0, TEST_REPLY_CHARS) };
}

/**
 * @brief 测试连接（§9.1、§9.4）：经模型池的 conversation 类别发一条短消息；不带 keyRef 时用第一个可用的 key，
 *        带 keyRef 时只用这个 key、不看它的记录。测试是你点的，不看任何不可用记录、总是发出（ignoreRecords，§8.3 的
 *        2026-10-26 补：原来一次 404 或 401 之后什么都不改再测，模型池按记录不发出，结果是"Connection error."）。
 *        没有 v0 的 30 秒总时限：排队按 §8.2，每次尝试按首个内容的时限，不做原地重试（server 直接报告）。
 *        你点"Cancel"即中止。
 * @param request 提供商、模型与可选的 key
 */
export async function testConnection(request: TestRequest): Promise<TestResult> {
  const layer = await getModelLayer();
  const attempt = new AbortController();
  const ref = `${request.providerId}/${request.modelId}`;
  // §7.8：按模型学的时限，还没有记录时用上限（首字很慢的端点第一次测试也等得到）
  const run: TestRun = { started: Date.now(), ref, sentToFirstMs: null, controller: new AbortController(),
    record: null, watch: firstContentWatch(layer.firstTokenLimitOf(ref, 'probe'), attempt) };
  const result: TestResult = { ok: false, cancelled: false, firstTokenMs: null, totalMs: 0, text: '', thinking: false,
    error: null };
  const found = layer.lookupModel(ref);
  const model = layer.getRuntime().getModel(request.providerId, request.modelId);
  if (!found || !model) return { ...result, error: `${ref} is not in your model settings` };
  runningTest?.abort();
  runningTest = run.controller;
  const fetch = layer.getPool().createFetch({ ref, api: found.provider.api, sessionKey: 'connection test',
    cls: 'conversation', signal: run.controller.signal, attemptSignal: attempt.signal, keyRef: request.keyRef,
    ignoreRecords: true, serverRetries: false, onSent: run.watch.arm, onRecord: (record) => { run.record = record; } });
  const message = { role: 'user' as const, content: 'Reply with one short sentence.', timestamp: run.started };
  try {
    const stream = layer.getRuntime().streamSimple(model, { messages: [message] }, {
      apiKey: layer.timings.placeholderApiKey, fetch, signal: AbortSignal.any([run.controller.signal, attempt.signal]),
      maxRetries: 0, timeoutMs: NO_TIMEOUT_MS, maxTokens: TEST_MAX_TOKENS,
      // §7.7：勾了 Supports thinking 的模型带 medium，否则不带
      reasoning: model.reasoning ? TEST_REASONING : undefined });
    await drainTest(stream, run, result);
  } catch (error) {
    result.error = (error as Error).message;
  } finally {
    run.watch.clear();
    if (runningTest === run.controller) runningTest = null;
  }
  return finishTest(request, run, result);
}

/** @brief 取消正在进行的测试连接；没有在测试时返回 false。 */
export function cancelTest(): boolean {
  if (!runningTest) return false;
  runningTest.abort();
  return true;
}
