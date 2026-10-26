// “一次命令一次编译、一次写入”（docs/specs/model-discovery.md §5.4；§13.2 MD-09、MD-10、MD-11）的单元测试工具：
// 经 modelCommands.ts 的 handleModelsCommand 跑真正的模型层（modelLayer.ts 的 ModelLayer，文件写在临时目录），
// 记下每条命令里的编译、pi 的 registerProvider 与 refresh、model-config.json 的写入。替身都是 synthetic：
// - pi 的运行时（同 tests/unit/modelLayer.test.mjs 的 fakeRuntime）：记下注册的内容，streamSimple 立即以连接错误结束；
// - getModelLayer 返回这里建的 ModelLayer（tests/unit/memory/enhance-harness.mjs 的 loadBundle 把 ./modelLayer 换成替身，
//   真正的 modelLayer.ts 作为同一个包的另一个入口，与 modelCommands.ts 共用 credentials.ts 等模块）；
// - 主进程的加密保存（process.parentPort，credentials.ts 的 requestStoreKey）：记下每条 store-key，回答成功；
// - 全局 fetch（探针第 0 步的读取器用它）：挂起到检查完，之后以连接失败结束，所以检查期间探针不会保存档案、不会再编译；
// - node:fs/promises 的 writeFile 与 rename 换成先记录再照做的版本（node:module 的 syncBuiltinESMExports 让打包结果里
//   import 的绑定跟着变），只数写到 model-config.json 及其临时文件的。
// 文件名不以 .test.mjs 结尾，node --test 不单独运行它。

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hooks, loadBundle } from '../memory/enhance-harness.mjs';

const require = createRequire(import.meta.url);

/** 一个包里的模块：命令、真正的模型层、主进程通道、配置与档案的纯函数、命令的 zod schema */
export const kernel = await loadBundle({
  commands: 'src/kernel/modelCommands.ts', layer: 'src/kernel/modelLayer.ts', credentials: 'src/kernel/credentials.ts',
  modelConfig: 'src/kernel/modelConfig.ts', profiles: 'src/kernel/modelProfiles.ts', shared: 'src/shared/models.ts',
}, ['modelLayer']);

/** 保留 id：mori 与一个 pi 内置的提供商 id（同 modelLayer.test.mjs） */
const RESERVED = kernel.modelConfig.reservedIds(['openai']);

/** 探针第 0 步的请求在检查完之后得到的连接错误（synthetic） */
const REFUSED = 'connect ECONNREFUSED 127.0.0.1:9';

/** @brief 一个清单行加入后的模型（synthetic）：窗口 32768、输出 8192、只有文字。 */
export function listed(id) {
  return { id, family: '', contextWindow: 32768, maxTokens: 8192, reasoning: false, input: ['text'] };
}

/** @brief 提供商表单的值（synthetic）：OpenAI-compatible、没有兼容选项。 */
export function form(name, baseUrl) {
  return { name, api: 'openai-completions', baseUrl, compat: {}, concurrency: 4 };
}

/** @brief 已有的提供商 p（synthetic，§4.1 的形状）：模型 m1、m2，key p#1。 */
export function providerP() {
  return { id: 'p', name: 'P', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/p/v1',
    compat: {}, concurrency: 4, keys: [{ ref: 'p#1', label: 'Key 1' }], nextKeyNumber: 2,
    models: [listed('m1'), listed('m2')] };
}

/** @brief 只有提供商 p 的配置。 */
export function configWithP() {
  return { version: 1, providers: [providerP()], groups: [], normalDefault: 'p/m1' };
}

/** @brief p 的每个模型一份全部通过的已存档案（同 modelLayer.test.mjs 的 storedProfile），它们不会被再探测。 */
function storedProfiles(provider) {
  const pass = { outcome: 'pass', detail: null };
  const skip = { outcome: 'not_applicable', detail: null };
  const auto = { server: { kind: 'unknown', version: 'unknown' }, reported: null, field: 'none',
    steps: { ready: pass, thinking: skip, call: pass, result: pass, replay: skip, a: pass, b: pass,
      c: { outcome: 'not_run', detail: null } } };
  return provider.models.map((model) => kernel.profiles.buildProfile({ target: { baseUrl: provider.baseUrl,
    api: provider.api, model, compat: provider.compat }, auto, now: 5 }));
}

/** @brief pi 的 streamSimple 替身（synthetic）：每个请求立即以连接错误结束。 */
function failingStream(model) {
  const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'error', errorMessage: 'Connection error.', timestamp: 1 };
  return {
    async *[Symbol.asyncIterator]() { yield { type: 'error', reason: 'error', error: message }; },
    result: async () => message,
  };
}

/** @brief pi 运行时的替身（synthetic）：registers 按调用顺序记下 { id, models }，refreshes 为刷新次数。 */
function countingRuntime() {
  return {
    registered: new Map(), registers: [], unregisters: [], refreshes: 0,
    registerProvider(id, input) {
      this.registers.push({ id, models: input.models.map((model) => model.id) });
      this.registered.set(id, input);
    },
    unregisterProvider(id) {
      this.unregisters.push(id);
      this.registered.delete(id);
    },
    async refresh() { this.refreshes += 1; },
    getModel(providerId, modelId) {
      const input = this.registered.get(providerId);
      const model = input?.models.find((item) => item.id === modelId);
      return model ? { ...model, provider: providerId, baseUrl: input.baseUrl } : undefined;
    },
    getProviders() { return []; },
    streamSimple: failingStream,
  };
}

/**
 * @brief 全局 fetch 换成挂起的替身：每个请求等到 release()（或自己的 signal 中止）后以连接失败结束。
 * @return { urls, release, restore }
 */
function heldFetch() {
  const urls = [];
  let release = () => {};
  const opened = new Promise((resolve) => { release = resolve; });
  const original = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => new Promise((resolve, reject) => {
    urls.push(String(input));
    const signal = init.signal;
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    opened.then(() => reject(new TypeError('fetch failed', { cause: new Error(REFUSED) })));
    return undefined;
  });
  return { urls, release, restore: () => { globalThis.fetch = original; } };
}

/**
 * @brief 记下写到 configPath（及其临时文件 <configPath>.<uuid>.tmp）的 writeFile 与改名到 configPath 的 rename。
 * @return { writes, renames, restore }
 */
function watchConfigWrites(configPath) {
  const fsp = require('node:fs/promises');
  const original = { writeFile: fsp.writeFile, rename: fsp.rename };
  const writes = [];
  const renames = [];
  fsp.writeFile = (path, ...rest) => {
    if (String(path).startsWith(configPath)) writes.push(String(path));
    return original.writeFile(path, ...rest);
  };
  fsp.rename = (from, to, ...rest) => {
    if (String(to) === configPath) renames.push(String(from));
    return original.rename(from, to, ...rest);
  };
  syncBuiltinESMExports();
  return { writes, renames, restore: () => { Object.assign(fsp, original); syncBuiltinESMExports(); } };
}

/**
 * @brief 主进程的替身（synthetic）：process.parentPort 收到 store-key 时记下 { ref, key }，下一轮回答成功。
 * @return { stored, restore }
 */
function syntheticMain() {
  const stored = [];
  const previous = Object.getOwnPropertyDescriptor(process, 'parentPort');
  Object.defineProperty(process, 'parentPort', { configurable: true, writable: true, value: {
    postMessage(message) {
      if (message.type !== 'store-key') return;
      stored.push({ ref: message.ref, key: message.key });
      setImmediate(() => kernel.credentials.onStoreKeyResult(message.id, null));
    },
  } });
  const restore = () => {
    if (previous) Object.defineProperty(process, 'parentPort', previous);
    else delete process.parentPort;
  };
  return { stored, restore };
}

/** @brief 把 compiler.compile 换成先计数再照做的版本（编译器在模型层里只有一个）。 */
function countCompiles(layer) {
  const counter = { compiles: 0 };
  const compiler = layer.compiler;
  const compile = compiler.compile.bind(compiler);
  compiler.compile = (...args) => {
    counter.compiles += 1;
    return compile(...args);
  };
  return counter;
}

/**
 * @brief 静默 console（模型层记的探针失败、读不到列表等日志），返回还原的函数。
 */
function quietConsole() {
  const originals = { log: console.log, error: console.error, warn: console.warn };
  for (const name of Object.keys(originals)) console[name] = () => {};
  return () => Object.assign(console, originals);
}

/** @brief 等这层的探针全部结束、修改队列空下来（最多 20 秒）。 */
async function settle(layer) {
  const deadline = Date.now() + 20_000;
  while (layer.getProfiles().running().length > 0) {
    if (Date.now() > deadline) throw new Error('synthetic: the probes did not finish in 20 s');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await layer.edit(async () => undefined);
}

/**
 * @brief 已有档案、但还不在配置里的模型（synthetic）：同一地址上以前探测过、之后删掉的模型，档案还在。
 *        加入它时指纹与档案相同、不会自动探测，只有命令把它放进 probeRefs（§5.4）才会探测。
 * @param baseUrl 地址
 * @param ids 模型 id
 */
export function profiledAt(baseUrl, ids) {
  return { baseUrl, api: 'openai-completions', compat: {}, models: ids.map(listed) };
}

/**
 * @brief 临时 userData：model-config.json、model-profiles.json（配置里每个模型、再加 profiled 的模型各一份档案）、
 *        pi 的 agentDir。
 * @param config 已有的配置；没有时为 null
 * @param profiled profiledAt 的结果
 */
function scratchDir(config, profiled) {
  const dir = mkdtempSync(join(tmpdir(), 'mori-md-once-'));
  const agentDir = join(dir, 'pi');
  mkdirSync(agentDir);
  process.env.PI_OFFLINE = '1';
  process.env.PI_TELEMETRY = '0';
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const paths = { config: join(dir, 'model-config.json'), profiles: join(dir, 'model-profiles.json'),
    notice: join(dir, 'model-migration.json'), v0Models: join(agentDir, 'models.json') };
  if (config) writeFileSync(paths.config, JSON.stringify(config));
  const profiles = [...(config?.providers ?? []), ...profiled].flatMap(storedProfiles);
  if (profiles.length > 0) writeFileSync(paths.profiles, JSON.stringify({ version: 1, profiles }));
  return { dir, paths };
}

/**
 * @brief 一个读过配置的模型层（ModelLayer.load），装好计数；测试结束时放开探针、等它们结束、还原替身、删目录。
 * @param t node:test 的测试上下文
 * @param options { config：已有的配置（没有时是首次启动）, secrets：已存 key 的明文,
 *                  profiled：已有档案、不在配置里的模型（profiledAt 的结果） }
 * @return { layer, runtime, paths, fetch, writes, main, counts, readConfig }
 */
export async function layerScenario(t, { config = null, secrets = {}, profiled = [] } = {}) {
  const { dir, paths } = scratchDir(config, profiled);
  const restoreConsole = quietConsole();
  const fetch = heldFetch();
  const main = syntheticMain();
  const runtime = countingRuntime();
  const layer = new kernel.layer.ModelLayer(runtime, RESERVED, paths, () => {});
  let writes = null;
  t.after(async () => {
    try {
      fetch.release();
      await settle(layer);
    } finally {
      writes?.restore();
      fetch.restore();
      main.restore();
      restoreConsole();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
  await layer.load(secrets, Object.keys(secrets), null);
  hooks().modelLayer = layer;
  writes = watchConfigWrites(paths.config);
  const counts = countCompiles(layer);
  const readConfig = () => JSON.parse(readFileSync(paths.config, 'utf8'));
  return { layer, runtime, paths, fetch, writes, main, counts, readConfig };
}

/**
 * @brief 经 zod schema（shared/models.ts 的 ModelCommandSchemas，同进程桥）检查后交给 handleModelsCommand。
 * @param command models.* 命令
 * @return 命令的结果
 */
export function runCommand(command) {
  const parsed = kernel.shared.ModelCommandSchemas.map((schema) => schema.safeParse(command))
    .find((result) => result.success);
  if (!parsed) throw new Error(`synthetic: ${command.type} does not match its schema`);
  return kernel.commands.handleModelsCommand(parsed.data);
}

/**
 * @brief 一条命令里的编译与写入：counts、runtime、writes 在命令开始前清零，命令结束后再等 50 ms
 *        （命令之后推迟的编译或写入也会被数到；探针挂在第 0 步的请求上，不会保存档案、不会再编译）。
 * @param scenario layerScenario 的结果
 * @param command models.* 命令
 * @return { result, compiles, registers, unregisters, refreshes, writes, renames, running }
 */
export async function measured(scenario, command) {
  const { counts, runtime, writes, layer } = scenario;
  counts.compiles = 0;
  runtime.registers.length = 0;
  runtime.unregisters.length = 0;
  runtime.refreshes = 0;
  writes.writes.length = 0;
  writes.renames.length = 0;
  const result = await runCommand(command);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { result, compiles: counts.compiles, registers: [...runtime.registers], unregisters: [...runtime.unregisters],
    refreshes: runtime.refreshes, writes: [...writes.writes], renames: [...writes.renames],
    running: layer.getProfiles().running().map((item) => item.ref).sort() };
}
