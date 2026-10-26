// 一键拉取模型 App 层"提供商卡、探针与模型行"套件（tests/ui/md-app-card.mjs）用的准备、操作与读取
// （docs/specs/model-discovery.md §13.1、§13.2；界面标识见 docs/v1/screens/models-settings.md "界面测试用的标识"）：
// - 合成端点（tests/fake-endpoint/server.mjs，synthetic）：每个端口一个进程，收集它的 JSON 日志行（列表与详情请求
//   {port, path, key}，对话请求 {port, model, key, probe, …}），每行带收到的时刻 t；
// - 数据目录（synthetic test setup）：model-config.json、model-profiles.json（"旧档案"：没有 auto.meta，表示一键拉取模型
//   之前写的档案，§7.2）、pi/settings.json；
// - App：启动（收集主进程与后台进程的输出、页面报错）、关闭、经进程桥发命令（window.mori.request）、打开设置 → Models；
// - 读：models.get 的档案、提供商卡（拉取的按钮、清单的行、列表错误、Add a model ID 一行）、模型行（(default) 与提示）。
// 只读页面和磁盘、发界面操作与进程桥命令，不记录检查结果（由 md-app-card.mjs 记录）。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isListPath } from '../fake-endpoint/discovery.mjs';
import { appRoot, launch, sleep } from './lib.mjs';

/** 合成端点 /version、/api/version 返回的服务版本（server.mjs 的默认 FAKE_SERVER_VERSION） */
export const FAKE_VERSION = '0.10.1';
/** 合成端点的地址（列表在 <base>/models） */
export const baseOf = (port) => `http://127.0.0.1:${port}/v1`;
/** 一行概括（检查的 detail） */
export const brief = (value, max = 1200) => String(typeof value === 'string' ? value : JSON.stringify(value))
  .replace(/\s+/g, ' ').slice(0, max);

/** @brief 反复读 read()，直到 test 通过或超时；返回是否通过与最后读到的值。 */
export async function poll(read, test, timeout = 30000, step = 200) {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!test(value) && Date.now() < deadline) {
    await sleep(step);
    value = await read();
  }
  return { ok: Boolean(test(value)), value };
}

/** @brief 读 JSON 文件；不存在或读不出时为 null。 */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** @brief 读文本文件；不存在时为 null。 */
export const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

// ---------- 合成端点 ----------

/**
 * @brief 启动一个合成端点（synthetic），等它打出 synthetic 启动行；stdout 的 JSON 日志行（带收到的时刻 t）放进 logs。
 * @param port 端口（本套件的 4820–4839）
 * @param env 额外的环境变量（FAKE_LIST_SHAPE、FAKE_MODELS、FAKE_KEYS、FAKE_LIST_DELAY_MS 等，见 server.mjs 开头）
 * @return { child, port, logs }
 */
export function startFake(port, env = {}) {
  const child = spawn(process.execPath, [join(appRoot, 'tests/fake-endpoint/server.mjs')], {
    env: { ...process.env, FAKE_PORT: String(port), FAKE_CHUNK_DELAY_MS: '5', FAKE_FIRST_DELAY_MS: '20', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const fake = { child, port, logs: [] };
  let rest = '';
  child.stderr.on('data', () => {});
  return new Promise((done, fail) => {
    // 没起来时结束这个进程再报错（调用方拿不到 fake，finally 里结束不了它）
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`fake endpoint ${port} did not start within 15 s`));
    }, 15000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`fake endpoint ${port} exited with ${code}`));
    });
    child.stdout.on('data', (chunk) => {
      rest += String(chunk);
      const lines = rest.split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const line of lines) {
        if (line.includes('synthetic endpoint on')) {
          clearTimeout(timer);
          done(fake);
        }
        if (!line.startsWith('{')) continue;
        try {
          fake.logs.push({ t: Date.now(), ...JSON.parse(line) });
        } catch {
          // 不是日志行
        }
      }
    });
  });
}

/** @brief 结束一个合成端点进程，等它退出（最多 5 秒）。 */
export async function stopFake(fake) {
  if (!fake || fake.child.exitCode !== null) return;
  const gone = new Promise((done) => fake.child.once('exit', done));
  fake.child.kill();
  await Promise.race([gone, sleep(5000)]);
}

/** @brief since 之后的列表请求（GET 路径以 /models 结尾、不是 LM Studio 的 /api/v1/models，server.mjs 的认法）。 */
export const listLines = (fake, since = 0) => fake.logs.filter((line) => line.t >= since && line.path !== undefined
  && isListPath(line.path));

/** @brief since 之后列表以外的发现请求（版本、§3.3 第 6 步、§4.2 的详情），可按路径筛。 */
export const detailLines = (fake, since = 0, path = null) => fake.logs.filter((line) => line.t >= since
  && line.path !== undefined && !isListPath(line.path) && (path === null || line.path === path));

/** @brief since 之后的探针对话请求（日志行没有 path、probe 为真），可按模型筛。 */
export const probeLines = (fake, since = 0, model = null) => fake.logs.filter((line) => line.t >= since
  && line.path === undefined && line.probe === true && (model === null || line.model === model));

// ---------- 数据目录（synthetic test setup） ----------

/** @brief 一个模型的配置（统一模型提供商规格 §4.1）。 */
export function modelOf(id, { contextWindow = 131072, maxTokens = 8192, reasoning = false, image = false,
  family = '' } = {}) {
  return { id, family, contextWindow, maxTokens, reasoning, input: image ? ['text', 'image'] : ['text'] };
}

/**
 * @brief 一个提供商的配置：本机地址，没有 key（启动后经 models.addKey 加，密文由 Mori 自己加密保存）。
 * @param api 接口（默认 openai-completions）
 */
export function providerOf(id, name, port, models, api = 'openai-completions') {
  return { id, name, api, baseUrl: baseOf(port), compat: {}, concurrency: 4,
    keys: [], nextKeyNumber: 1, models };
}

/** @brief 探针一步的结果。 */
const step = (outcome) => ({ outcome, detail: null });

/**
 * @brief 旧档案（synthetic test setup）：一键拉取模型之前写的档案，没有 auto.meta（§7.2），tool_calling 已验证、A 级。
 *        键与指纹按 kernel/modelProfiles.ts 的写法算（profileKey、profileFingerprint，兼容选项为空），启动时不因指纹重新探测。
 * @param baseUrl 提供商地址
 * @param model modelOf 的结果
 * @param opts { kind（服务种类，默认 vllm）, version（默认 FAKE_VERSION）, reported（auto.reported，默认 null）,
 *              field（推理字段，默认 none）, probedAt, api（提供商的接口，默认 openai-completions） }
 */
export function oldProfile(baseUrl, model, opts = {}) {
  const { kind = 'vllm', version = FAKE_VERSION, reported = null, field = 'none' } = opts;
  const api = opts.api ?? 'openai-completions';
  const key = [baseUrl, api, model.id, version].join('|');
  const fingerprint = JSON.stringify([key, model.contextWindow, model.maxTokens, model.reasoning, model.input, []]);
  return {
    key, fingerprint, baseUrl, api, modelId: model.id,
    auto: { server: { kind, version }, reported, field,
      steps: { ready: step('pass'), thinking: step(model.reasoning ? 'pass' : 'not_applicable'), call: step('pass'),
        result: step('pass'), replay: step('not_applicable'), a: step('pass'), b: step('pass'), c: step('not_run') } },
    probedAt: opts.probedAt ?? Date.now() - 3600000, suite: 1,
  };
}

/**
 * @brief 新的临时数据目录，写好 model-config.json、model-profiles.json 与 pi/settings.json（synthetic test setup）。
 * @param setup { providers, profiles（oldProfile 的列表，默认无）, piSettings（默认 {}）, normalDefault（默认 null） }
 * @return 数据目录
 */
export function seedUserData(setup) {
  const userData = mkdtempSync(join(tmpdir(), 'mori-md-card-'));
  mkdirSync(join(userData, 'pi'), { recursive: true });
  const config = { version: 1, providers: setup.providers, groups: [], normalDefault: setup.normalDefault ?? null };
  writeFileSync(join(userData, 'model-config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const profiles = { version: 1, profiles: setup.profiles ?? [] };
  writeFileSync(join(userData, 'model-profiles.json'), `${JSON.stringify(profiles, null, 2)}\n`);
  writeFileSync(join(userData, 'pi', 'settings.json'), `${JSON.stringify(setup.piSettings ?? {}, null, 2)}\n`);
  return userData;
}

/** @brief 数据目录里的配置（model-config.json）。 */
export const configOf = (userData) => readJson(join(userData, 'model-config.json'));
/** @brief 配置里一个提供商。 */
export const providerIn = (config, id) => config?.providers?.find((provider) => provider.id === id) ?? null;
/** @brief 数据目录里的档案文件（model-profiles.json）中一个模型的档案（按地址与模型 id，取最后一份）。 */
export function storedProfile(userData, baseUrl, modelId) {
  const list = readJson(join(userData, 'model-profiles.json'))?.profiles ?? [];
  return list.filter((item) => item.baseUrl === baseUrl && item.modelId === modelId).at(-1) ?? null;
}
/** @brief pi 设置里一个模型的新会话思考强度（modelThinkingLevels["<provider>/<model>"]）；没有时为 null。 */
export function savedThinking(userData, ref) {
  return readJson(join(userData, 'pi', 'settings.json'))?.modelThinkingLevels?.[ref] ?? null;
}

// ---------- App ----------

/**
 * @brief 用 userData 启动 Mori，收集主进程与后台进程的输出（ctx.logs）和页面报错，等到三栏布局出现。
 * @param exePath 打包好的 Mori.exe；为 null 时启动开发构建（out/）
 */
export async function startApp(userData, exePath) {
  const app = await launch({ exePath, userData });
  const page = await app.firstWindow();
  const ctx = { app, page, userData, logs: [], pageErrors: [] };
  app.process().stdout?.on('data', (chunk) => ctx.logs.push(String(chunk)));
  app.process().stderr?.on('data', (chunk) => ctx.logs.push(String(chunk)));
  page.on('console', (message) => ctx.logs.push(message.text()));
  page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  await page.waitForSelector('[data-testid="sidebar"]', { timeout: 60000 });
  return ctx;
}

/** @brief 关闭 Mori（没启动时什么也不做）；正常关闭失败时记一行并结束它的进程，不留进程。 */
export async function closeApp(ctx) {
  if (!ctx) return;
  await ctx.app.close().catch((error) => {
    console.log(`[md-app-card] closing Mori failed (${error?.message ?? error}); killing its process`);
    ctx.app.process().kill();
  });
  await sleep(500);
}

/** @brief 经进程桥发一条命令（window.mori.request），返回结果；不经界面。 */
export const bridge = (page, command) => page.evaluate((cmd) => window.mori.request(cmd), command);

/** @brief models.get 的结果（经进程桥）。 */
export const modelsInfo = (page) => bridge(page, { type: 'models.get' });

/**
 * @brief 测试准备：经 models.addKey 给提供商加 key（同 v1-models-app-switch.mjs 的 addKeys；密文由 Mori 加密保存）。
 * @throws 加 key 失败
 */
export async function addKeyBridge(page, providerId, label, secret) {
  const result = await bridge(page, { type: 'models.addKey', providerId, label, secret });
  if (result?.error) throw new Error(`models.addKey ${providerId}: ${result.error}`);
  return result.ref;
}

/** @brief 打开设置页的 Models 分节，等它读完。 */
export async function openModels(page) {
  if (!(await page.getByTestId('settings-page').isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByTestId('settings-page').waitFor({ timeout: 10000 });
  }
  await page.locator('[data-testid="settings-nav"] button[data-section="models"]').click();
  await page.getByTestId('models-section').waitFor({ timeout: 20000 });
}

/**
 * @brief 等 models.get 的档案里 refs 全部满足 test（最多 timeout）；返回 { ok, value: { ref → ProfileView|null } }。
 * @param test (profile) => boolean
 */
export function waitProfiles(page, refs, test, timeout = 120000) {
  const read = async () => {
    const info = await modelsInfo(page);
    return Object.fromEntries(refs.map((ref) => [ref, info?.profiles?.[ref] ?? null]));
  };
  return poll(read, (views) => refs.every((ref) => views[ref] && test(views[ref])), timeout, 500);
}

/** @brief 探针跑完且 tool calling 已验证的档案。 */
export const verified = (profile) => profile?.status === 'ready' && profile.tool_calling.state === 'verified';

// ---------- 页面 ----------

/** @brief 提供商卡。 */
export const cardOf = (page, id) => page.locator(`[data-testid="provider-card"][data-provider="${id}"]`);
/** @brief 卡头上的 Fetch models（卡上的清单里没有这个按钮）。 */
export const cardFetch = (page, id) => cardOf(page, id).locator('header [data-action="fetch-models"]');
/** @brief 模型行（provider/id）。 */
export const modelRow = (page, ref) => page.locator(`[data-testid="model-row"][data-model="${ref}"]`);

/**
 * @brief 一张提供商卡此刻的样子：卡头的 Fetch models（文字、是否不可用）、拉取中的 Cancel、拉取的状态、清单、列表错误、
 *        Detected 一行的个数、Not listed 一行、清单的行（勾选、标记、提示、输入框是否不可用）、Add 按钮、卡里的原文、
 *        卡上 Add model 按钮的个数、模型行的顺序、卡里任何地方有没有"Fetch cancelled"这句。卡不在时为 null。
 */
export function cardState(page, id) {
  return page.evaluate((providerId) => {
    const card = document.querySelector(`[data-testid="provider-card"][data-provider="${providerId}"]`);
    if (!card) return null;
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
    const fetch = card.querySelector('header [data-action="fetch-models"]');
    const status = card.querySelector('[data-testid="fetch-status"]');
    const listError = card.querySelector('[data-testid="list-error"]');
    const add = card.querySelector('[data-action="add-models"]');
    const rows = [...card.querySelectorAll('[data-testid="discovered-row"]')].map((row) => ({
      id: row.dataset.model, added: row.dataset.added === 'true', chat: row.dataset.chat,
      picked: row.querySelector('input[name="pick"]')?.checked ?? null,
      pickDisabled: row.querySelector('input[name="pick"]')?.disabled ?? null,
      fields: [...row.querySelectorAll('input[data-field]')].map((input) => ({ field: input.dataset.field,
        disabled: input.disabled })),
      tags: [...row.querySelectorAll('[data-testid="row-tag"]')].map((tag) => `${tag.dataset.kind}:${text(tag)}`),
    }));
    return {
      fetch: fetch ? { text: text(fetch), disabled: fetch.disabled } : null,
      cancel: Boolean(card.querySelector('[data-action="fetch-cancel"]')),
      status: status ? { state: status.dataset.state, text: text(status) } : null,
      checklist: Boolean(card.querySelector('[data-testid="checklist"]')),
      listError: listError ? { kind: listError.dataset.kind, text: text(listError) } : null,
      detected: card.querySelectorAll('[data-testid="detected-server"]').length,
      notListed: text(card.querySelector('[data-testid="not-listed"]')),
      rows, add: add ? { text: text(add), disabled: add.disabled } : null,
      message: text(card.querySelector('[data-testid="form-message"]')),
      addModel: card.querySelectorAll('[data-action="add-model"]').length,
      models: [...card.querySelectorAll('[data-testid="model-row"]')].map((row) => row.dataset.model),
      cancelledText: card.textContent.includes('Fetch cancelled'),
    };
  }, id);
}

/**
 * @brief 卡上清单的 Add a model ID 一行此刻的样子（models-settings.md "界面测试用的标识"）：输入框的文字、id 的字段错误
 *        （没有时为 null）、Add to list 是否不可用。这一行不在时为 null。
 */
export function manualState(page, id) {
  return page.evaluate((providerId) => {
    const card = document.querySelector(`[data-testid="provider-card"][data-provider="${providerId}"]`);
    const line = card?.querySelector('[data-testid="manual-model"]');
    if (!line) return null;
    return {
      text: line.querySelector('input[data-field="id"]')?.value ?? null,
      error: line.querySelector('[data-testid="field-error"][data-field="id"]')?.textContent.trim() ?? null,
      blocked: line.querySelector('[data-action="add-to-list"]')?.disabled ?? null,
    };
  }, id);
}

/** @brief 在卡上清单的 Add a model ID 输入框里填 text（替换原有的文字，同你在框里改字）。 */
export const typeManual = (page, id, text) => cardOf(page, id)
  .locator('[data-testid="manual-model"] input[data-field="id"]').fill(text);

/**
 * @brief 一行模型此刻的样子：说明（窗口、最大输出…）、标了"(default)"的字段与它们的悬停说明、提示（data-kind、文字、
 *        有没有 Use）、行上的 data-probe（tool calling 的验证状态）、状态行的 data-state（没有状态行时为 null）、行里的
 *        错误原文。行不在时为 null。2026-10-26（WP-02，models-settings.md "Models 行"）：没有档案摘要（Context、Cancel test…），
 *        "(not reported)"改为只在值仍是默认值时标的"(default)"。
 */
export function modelRowState(page, ref) {
  return page.evaluate((key) => {
    const row = document.querySelector(`[data-testid="model-row"][data-model="${key}"]`);
    if (!row) return null;
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
    return {
      meta: text(row.querySelector('.model-meta')),
      defaults: [...row.querySelectorAll('[data-testid="default-value"]')].map((el) => el.dataset.field),
      defaultTitles: [...row.querySelectorAll('[data-testid="default-value"]')].map((el) => el.title),
      hints: [...row.querySelectorAll('[data-testid="model-hint"]')].map((el) => ({ kind: el.dataset.kind,
        text: text(el.querySelector('.muted')), use: Boolean(el.querySelector('[data-action="use-reported"]')) })),
      tool: row.dataset.probe ?? null,
      status: row.querySelector('[data-testid="probe-status"]')?.dataset.state ?? null,
      error: text(row.querySelector('.form-message.error')),
    };
  }, ref);
}

/** @brief 页面里能看到的全部文字：整个 DOM 的 HTML 加上每个输入框此刻的值（值不一定在 HTML 属性里）。 */
export function pageDump(page) {
  return page.evaluate(() => [document.documentElement.outerHTML,
    ...[...document.querySelectorAll('input, textarea, select')].map((el) => el.value)].join('\n'));
}

/** @brief text 里出现的 secrets（返回末 4 位）。 */
export const secretsIn = (text, secrets) => secrets.filter((secret) => String(text).includes(secret))
  .map((secret) => secret.slice(-4));
