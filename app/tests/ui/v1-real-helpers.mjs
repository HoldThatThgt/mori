// v1 模型层的真实走查与录制（v1-models-real.mjs、v1-models-record.mjs；key 方式另有 md-real.mjs）共用的准备与操作，做法按
// docs/specs/model-providers.md §14.1"真实模型与录制"：
// 1. 复制数据目录：只复制加密的 credentials.json、Electron 的 Local State（解密要用）、model-config.json、
//    model-profiles.json 和 pi/settings.json（按模型的思考强度）；不复制 pi/models.json，从不读取或打印 key。
// 2. 测试准备（synthetic test setup，写在复制出的 model-config.json 里）：建一个分组 [首选提供商, 第二个提供商] 作为默认范围，
//    给临时项目授权公网（projectZones）；把首选提供商第一个 key 的密文原样另存到一个备用 ref（只复制密文字符串）。
// 3. 故障用真实方式触发：在界面里给首选提供商加一个错的 key（sk-invalid），再删掉原来的 key，之后的请求得到真实的 401。
// 4. 恢复：退出 App 后把配置里首选提供商的 key 改指备用 ref（并把备份的密文写回这个 ref：在界面里删掉这个 key 时
//    App 会删掉它的密文），重新启动。
// 5. MP-40（§7.7，§14.1 的 2026-10-24 补）：OpenRouter 的提供商按名称或地址含 openrouter 找（同 md-real-helpers.mjs）；
//    复制出的配置里已有那两个免费模型时先去掉（synthetic test setup）；经卡上的 Fetch models（或 Add provider，key 只输进
//    Mori 的密码框）过滤、勾选、加入；输入框下面一行的范围与 Effort 菜单的操作。拉取与清单的读法用 md-real-helpers.mjs 的。
// 6. key 方式（§14.1 的 2026-10-24 补，负责人定：选项 A）：只经界面建数据目录的步骤——首次启动表单接 DeepSeek
//    （firstRunDeepSeek）、Add provider（addProviderUi，GLM 用 chooseGlm，只勾一行用 tickOnly）、key 只输进 Mori 的
//    密码框（typeKey）——与这几步的问题清单（firstRunProblems、glmAddProblems、addedProblems、savedProblems）；
//    md-real.mjs（MD-14 的 key 方式）与 v1-models-real.mjs（MP-27、MP-40 的 key 方式）共用，两边不留自己的副本。
//    检查的名字、截图（shot 由调用方给）、OpenRouter 只勾哪一行由各自的脚本定（md-real.mjs 用自己的 chooseFree；
//    v1-models-real.mjs 给这里的 addOpenRouter 传 ids，它建在 tickModels 上）；地址默认为 KEY_MODE_URLS，md-real.mjs
//    用 MD_REAL_DEEPSEEK_URL、MD_REAL_GLM_URL 改时把地址经 baseUrl 传进来。
// 只读页面和磁盘，不记录检查结果（由调用方记录）。

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { editModelConfig, sleep } from './lib.mjs';
import { PANE, stubFolder, waitReady } from './m3-helpers.mjs';
import {
  addModelId, apiForUrl, attr, brief, cardIds, cardOf, DEEPSEEK_DOCS, fetchedState, freeModel, GLM_MANUAL_ID,
  modelRowOf, modelsGet, OPENROUTER_BASE, pickOnly, pollFor, probeStatus, readRows, rowOf as checklistRow, waitFetched,
  waitProbed, waitText,
} from './md-real-helpers.mjs';
import { cardScope } from './page.mjs';

/** 测试准备建的分组 id */
export const TEST_GROUP = 'mori-real-test';
/** 故障用的错的 key（§14.1）；只是一个不会被接受的字符串，不是任何服务的 key */
export const WRONG_KEY = 'sk-invalid';

/** @brief 读 JSON 文件。 */
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
/** @brief 写 JSON 文件（两格缩进，结尾换行）。 */
export const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/** @brief 首选提供商的 key 备份用的 ref（不在配置里，只在 credentials.json 里）。 */
export const spareRef = (providerId) => `mori-test-spare-${providerId}`;

/**
 * @brief 规范化项目路径，与后台进程 modelConfig.ts 的 normalizeProjectPath 相同（§4.1 projectZones 的键）。
 * @param path 项目文件夹的绝对路径（Windows）
 */
export function projectKey(path) {
  let normal = win32.normalize(path).replace(/\\/g, '/').toLowerCase();
  while (normal.length > 1 && normal.endsWith('/')) normal = normal.slice(0, -1);
  return normal;
}

/**
 * @brief 检查走查数据目录：要有 v1 的 model-config.json（先用 v1 打开过一次，§14.1）、credentials.json 和 Local State。
 * @return 缺的东西的说明；齐全时为空数组
 */
export function sourceProblems(source) {
  const need = ['model-config.json', 'credentials.json', 'Local State'];
  return need.filter((name) => !existsSync(join(source, name)))
    .map((name) => `${name} is missing in ${source}${name === 'model-config.json'
      ? ' (open the data dir with the v1 build once and confirm the zones first, spec §14.1)' : ''}`);
}

/**
 * @brief 复制走查数据目录到新的临时目录（只复制文件，不读 key）。
 * @return 新的数据目录
 */
export function scratchModelData(source) {
  const target = mkdtempSync(join(tmpdir(), 'mori-v1-real-data-'));
  mkdirSync(join(target, 'pi'), { recursive: true });
  for (const name of ['credentials.json', 'Local State', 'model-config.json', 'model-profiles.json']) {
    if (existsSync(join(source, name))) copyFileSync(join(source, name), join(target, name));
  }
  if (existsSync(join(source, 'pi', 'settings.json'))) {
    copyFileSync(join(source, 'pi', 'settings.json'), join(target, 'pi', 'settings.json'));
  }
  return target;
}

/** @brief 一个提供商是否像 name 指的那一家（按 id、名称、地址）。 */
const looksLike = (provider, pattern) => pattern.test(`${provider.id} ${provider.name} ${provider.baseUrl}`);

/**
 * @brief 找到两个真实提供商：首选（默认 DeepSeek）与第二个（默认 GLM）；--first / --second 可以直接给提供商 id。
 * @return { first, second }（model-config.json 里的提供商对象，不含 key 明文——配置里本来就只有 ref）
 */
export function findRealProviders(config, { first, second } = {}) {
  const byId = (id) => config.providers.find((provider) => provider.id === id);
  const a = first ? byId(first) : config.providers.find((provider) => looksLike(provider, /deepseek/i));
  const b = second ? byId(second) : config.providers.find((provider) => provider !== a
    && looksLike(provider, /glm|bigmodel|zhipu|z\.ai/i));
  const ids = config.providers.map((provider) => provider.id).join(', ');
  if (!a) throw new Error(`No first provider (${first ?? 'DeepSeek'}) in model-config.json; providers: ${ids}`);
  if (!b) {
    throw new Error(`No second real provider (${second ?? 'GLM'}) in model-config.json; providers: ${ids}. `
      + 'MP-27 needs two real providers (spec §14.1): add the second one in Mori first.');
  }
  for (const provider of [a, b]) {
    if (provider.zone === null) {
      throw new Error(`Zone of ${provider.id} is not confirmed; confirm it in v1 first (§14.1)`);
    }
  }
  if (a.keys.length === 0) throw new Error(`${a.id} has no key; the fault method needs its key (§14.1)`);
  return { first: a, second: b };
}

/**
 * @brief synthetic test setup（§14.1）：在复制出的 model-config.json 里建分组 [first, second] 作为默认范围，给 projects
 *        授权公网；把 first 第一个 key 的密文另存到备用 ref（只复制 credentials.json 里的密文字符串）。
 * @param projects 要授权公网的项目路径；空数组表示不授权（录拒绝启动卡用）
 * @return 首选提供商第一个 key 的密文（base64 字符串，原样留着给 restoreFirstKey 写回；不解密）
 */
export function prepareRealConfig(userData, { first, second }, projects) {
  const path = join(userData, 'model-config.json');
  const config = readJson(path);
  const taken = new Set([...config.providers.map((p) => p.id), ...config.groups.map((g) => g.id)]);
  if (taken.has(TEST_GROUP) && !config.groups.some((group) => group.id === TEST_GROUP)) {
    throw new Error(`${TEST_GROUP} is already a provider id in model-config.json`);
  }
  config.groups = [...config.groups.filter((group) => group.id !== TEST_GROUP),
    { id: TEST_GROUP, members: [first.id, second.id] }];
  config.normalDefault = TEST_GROUP;
  for (const project of projects) config.projectZones[projectKey(project)] = ['public'];
  writeJson(path, config);
  const credentials = readJson(join(userData, 'credentials.json'));
  const ref = config.providers.find((provider) => provider.id === first.id).keys[0].ref;
  if (!(ref in credentials)) throw new Error(`credentials.json has no ciphertext for ${ref}`);
  credentials[spareRef(first.id)] = credentials[ref];
  writeJson(join(userData, 'credentials.json'), credentials);
  return credentials[ref];
}

/**
 * @brief 恢复首选提供商的 key（App 已退出）：配置里它的 key 只留备用 ref，备用 ref 的密文写回 cipher（上一次故障在界面里
 *        删掉的可能正是它）；界面加的错 key 的密文从 credentials.json 删掉。
 * @param cipher prepareRealConfig 返回的密文
 */
export function restoreFirstKey(userData, providerId, cipher) {
  const path = join(userData, 'model-config.json');
  const config = readJson(path);
  const provider = config.providers.find((item) => item.id === providerId);
  const credentials = readJson(join(userData, 'credentials.json'));
  for (const key of provider.keys) {
    if (key.ref !== spareRef(providerId)) delete credentials[key.ref];
  }
  provider.keys = [{ ref: spareRef(providerId), label: 'Restored key' }];
  credentials[spareRef(providerId)] = cipher;
  writeJson(path, config);
  writeJson(join(userData, 'credentials.json'), credentials);
}

/** @brief 侧栏"设置" → Models 分节，等提供商卡出现。 */
export async function openModelsSettings(page) {
  await page.getByTestId('sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('settings-page').waitFor({ timeout: 10000 });
  await page.locator('[data-testid="settings-nav"] button[data-section="models"]').click();
  await page.getByTestId('provider-card').first().waitFor({ timeout: 30000 });
}

/** @brief 设置页顶部"返回会话"，等会话就绪。 */
export async function backToSession(page) {
  await page.getByTestId('settings-page').getByRole('button', { name: 'Back to app' }).click();
  await page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: 10000 });
  await waitReady(page);
}

/**
 * @brief 故障（§14.1）：设置 → Models 里给 providerId 加一个错的 key（Add key → Secret 填 sk-invalid → Save），
 *        再把原来的 key 逐个 Remove（这时不是最后一个 key，不用确认）。之后它的请求得到真实的 401。
 * @param back 做完后是否点"返回会话"
 * @return { removed: 删掉的 ref, added: 新 key 的 ref }
 */
export async function injectWrongKey(page, providerId, { back = true } = {}) {
  await openModelsSettings(page);
  const card = page.locator(`[data-testid="provider-card"][data-provider="${providerId}"]`);
  await card.scrollIntoViewIfNeeded();
  const rows = card.getByTestId('key-row');
  const before = await rows.evaluateAll((items) => items.map((item) => item.dataset.ref));
  await card.locator('[data-action="add-key"]').click();
  const form = card.getByTestId('key-form');
  await form.locator('input[type="password"]').fill(WRONG_KEY);
  await form.locator('button[type="submit"]').click();
  await form.waitFor({ state: 'detached', timeout: 15000 });
  await card.page().waitForFunction(({ id, count }) => document.querySelectorAll(
    `[data-testid="provider-card"][data-provider="${id}"] [data-testid="key-row"]`).length === count + 1,
  { id: providerId, count: before.length }, { timeout: 15000 });
  const after = await rows.evaluateAll((items) => items.map((item) => item.dataset.ref));
  const added = after.find((ref) => !before.includes(ref));
  for (const ref of before) {
    await card.locator(`[data-testid="key-row"][data-ref="${ref}"] [data-action="key-remove"]`).click();
    await card.locator(`[data-testid="key-row"][data-ref="${ref}"]`).waitFor({ state: 'detached', timeout: 15000 });
  }
  if (back) await backToSession(page);
  return { removed: before, added };
}

/** @brief 打开一个项目文件夹（synthetic stub：系统对话框换成直接返回 project），等会话就绪。 */
export async function openProjectFolder(app, page, project) {
  await stubFolder(app, project);
  await page.getByTestId('sidebar').getByRole('button', { name: 'Open folder…', exact: true }).click();
  await waitReady(page);
}

/** @brief 当前一栏的会话文件（侧栏里选中的一行）；没有时为 null。 */
export const activeSessionFile = (page) => page.locator('.session-item.active').first()
  .getAttribute('data-file', { timeout: 5000 }).catch(() => null);

/**
 * @brief 已经有打开的会话时在 project 里再开一个新会话（"Open folder…"；synthetic stub：系统对话框换成直接返回
 *        project）：等侧栏选中的一行换成新会话（不等的话原来那一栏还就绪着，会读到旧会话），再等它就绪。
 * @return 新会话的会话文件；30 秒内没有换过去时为 null
 */
export async function openNewSession(app, page, project) {
  const before = await activeSessionFile(page);
  await stubFolder(app, project);
  await page.getByTestId('sidebar').getByRole('button', { name: 'Open folder…', exact: true }).click();
  const file = await pollFor(() => activeSessionFile(page), (value) => Boolean(value) && value !== before, 30000, 500);
  await waitReady(page);
  return file && file !== before ? file : null;
}

/**
 * @brief 会话文件里的助手消息（按顺序）：实际模型 <provider>/<model>、停止原因、正文开头、工具调用数。
 *        包装后的流函数原样转发实际模型的消息，消息的 provider / model 是实际模型（§11.2）。
 */
export function assistantMessages(sessionFile) {
  if (!sessionFile || !existsSync(sessionFile)) return [];
  return readFileSync(sessionFile, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant').map(({ message }) => ({
      ref: `${message.provider}/${message.model}`, stopReason: message.stopReason,
      text: (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('')
        .slice(0, 80),
      tools: (message.content ?? []).filter((part) => part.type === 'toolCall').length,
    }));
}

/** @brief 会话文件里的自定义条目（mori.model_switch、mori.rebuild、mori.pick）的数据，按顺序。 */
export function customEntries(sessionFile, customType) {
  if (!sessionFile || !existsSync(sessionFile)) return [];
  return readFileSync(sessionFile, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'custom' && entry.customType === customType).map((entry) => entry.data);
}

/** @brief 当前一栏对话流里的换模型提示：文字与 data-*。 */
export function switchNotices(page) {
  return page.locator(`${PANE} [data-testid="notice"][data-kind="model-switch"]`).evaluateAll((items) => items
    .map((item) => ({ text: item.textContent, from: item.dataset.from, to: item.dataset.to, reason: item.dataset.reason,
      hidden: item.dataset.hidden === 'true' })));
}

/** @brief 当前一栏的错误卡、说明卡数量。 */
export async function cardCounts(page) {
  return { errors: await page.locator(`${PANE} [data-testid="error-card"]`).count(),
    unavailable: await page.locator(`${PANE} [data-testid="unavailable-card"]`).count() };
}

/**
 * @brief 当前一栏输入框下面一行的范围按钮：文字、data-pick、data-current；unavailable 为"不可用"（aria-disabled 且没有
 *        data-pending），pending 为"切换中"（data-pending），tip 为按行分开的悬停说明（docs/v0/composer-pickers.md C1、C2）。
 */
export function rangeButton(page) {
  return page.evaluate((pane) => {
    const button = document.querySelector(`${pane} [data-testid="model-button"]`);
    if (!button) return null;
    const pending = button.dataset.pending === 'true';
    return { text: button.textContent.replace(/▾/g, '').trim(), pick: button.dataset.pick ?? null,
      current: button.dataset.current ?? null, pending,
      unavailable: button.getAttribute('aria-disabled') === 'true' && !pending,
      tip: (button.getAttribute('title') ?? '').split('\n') };
  }, PANE);
}

/**
 * @brief 等档案里 refs 的探针都跑完（status 不是 probing、不在 running 里）：经 window.mori 读 models.get（只读查询）。
 * @return 最后一次读到的 models.get 结果
 */
export async function waitProfiles(page, refs, timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await page.evaluate(() => window.mori.request({ type: 'models.get' }));
    const done = refs.every((ref) => info.profiles[ref] && info.profiles[ref].status !== 'probing');
    if (done) return info;
    if (Date.now() > deadline) throw new Error(`Probes for ${refs.join(', ')} did not finish in ${timeoutMs / 1000} s`);
    await sleep(2000);
  }
}

/** 合理的探针结果允许的推理字段（§7.2） */
const FIELDS = ['reasoning_content', 'reasoning', 'reasoning_text', 'none', 'native'];
/**
 * 允许的服务种类：一键拉取模型之后第 0 步存读取器认出的种类（拉取规格 §3.3 的表，同 shared/models.ts 的
 * SERVER_KINDS；例如 api.deepseek.com 是 deepseek，api.z.ai 是 unknown），不再只是 §7.2 原来的五种
 */
const SERVERS = ['vllm', 'sglang', 'llamacpp', 'ollama', 'lmstudio', 'xinference', 'gpustack', 'mindie', 'tgi',
  'lmdeploy', 'localai', 'tensorrt', 'litellm', 'newapi', 'oneapi', 'deepseek', 'moonshot', 'dashscope', 'qianfan',
  'openrouter', 'anthropic', 'unknown'];

/**
 * @brief 一个真实模型的档案是否合理（MP-27"探针结果合理"）：探测完成、工具调用已验证、有交接写入等级、
 *        有效窗口在 (0, 声明的窗口]、推理字段与服务种类是允许的取值、记了完成时刻。
 * @return 不合理的地方；合理时为空数组
 */
export function profileProblems(profile, declaredWindow) {
  if (!profile) return ['no profile'];
  const problems = [];
  if (profile.status !== 'ready') {
    problems.push(`status ${profile.status}${profile.error ? ` (${profile.error})` : ''}`);
  }
  if (profile.tool_calling?.state !== 'verified') problems.push(`tool_calling ${profile.tool_calling?.state}`);
  if (!['A', 'B', 'C'].includes(profile.tier?.level)) problems.push(`tier ${profile.tier?.level}`);
  const effective = profile.context?.effective;
  if (!(effective > 0 && effective <= declaredWindow)) {
    problems.push(`effective window ${effective} / ${declaredWindow}`);
  }
  if (!FIELDS.includes(profile.reasoning?.field)) problems.push(`reasoning field ${profile.reasoning?.field}`);
  if (!SERVERS.includes(profile.server?.kind)) problems.push(`server ${profile.server?.kind}`);
  if (!profile.probedAt) problems.push('probedAt missing');
  return problems;
}

/** @brief 再写几个文件进项目，让一次回复要连续调好几次 read（段内换模型要在回复进行中换 key）。 */
export function addNotes(project, count = 5) {
  for (let i = 1; i <= count; i += 1) {
    writeFileSync(join(project, `notes-${i}.md`), `# Note ${i}\n\nThis is note number ${i} of the Mori walkthrough.\n`);
  }
  return Array.from({ length: count }, (_, i) => `notes-${i + 1}.md`);
}

// ---------- MP-40：思考关不掉的模型（docs/specs/model-providers.md §7.7，§14.1 的 2026-10-24 补） ----------

/** MP-40 的两个免费模型（§14.2 MP-40；2026-10-24 在 OpenRouter 上实测，见 docs/v1/models-checks.md） */
export const NO_OFF_MODELS = { flint: 'recursive/flint-v1.0:free', lfm: 'liquid/lfm-2.5-2.6b:free' };
/** 数据目录里没有 OpenRouter 的提供商时 Add provider 用的 key 的环境变量（§14.1） */
export const OPENROUTER_KEY_VAR = 'MP_REAL_OPENROUTER_KEY';
/** Effort 菜单底部的说明（model-menu.md"思考关不掉"、docs/v0/ui-strings.md） */
export const NO_OFF_NOTE = 'This model can’t turn thinking off.';
/** 档案摘要多的一项（models-settings.md"思考关不掉"） */
export const THINKING_OFF_TEXT = 'Thinking: Can’t be turned off';
/** 一次拉取的时限（列表请求 15 秒、最多 3 次，docs/specs/model-discovery.md §11） */
const FETCH_MS = 90000;
/**
 * 模型行 Test 的结果开头（models-settings.md"测试结果的文字"；connection.test 请求本身出错时同一处写
 * "Couldn’t test the connection: …"，settings.ts 的 runTest）
 */
const TEST_DONE = /^(Connected|Connection failed|Test cancelled|Couldn[’']t test)/;
/** 测试连接的时限（首个内容 120 秒，加上排队） */
const TEST_MS = 180000;

/**
 * @brief 读出环境变量 name 的值并立即从 process.env 删掉（之后启动的 Mori 拿不到）；值只留在调用方的内存里，不打印。
 * @return 去掉首尾空白的值；没有值时为 null
 */
export function takeEnvSecret(name) {
  const value = process.env[name]?.trim() || null;
  delete process.env[name];
  return value;
}

/** @brief OpenRouter 的提供商：id、名称或地址含 openrouter（不分大小写，同 md-real-helpers.mjs 的找法）；没有时为 null。 */
export const findOpenRouter = (config) => config.providers
  .find((provider) => looksLike(provider, /openrouter/i)) ?? null;

/**
 * @brief 找到的 OpenRouter 提供商能不能用来跑 MP-40：有保存的 key（key 的 ref 在 credentials.json 里，只看键名）、
 *        区域已确认（§14.1）。
 * @param refs credentials.json 的键名
 * @return 不能用的原因；能用时为空数组
 */
export function openRouterProblems(provider, refs) {
  const problems = [];
  if (!(provider.keys ?? []).some((key) => refs.includes(key.ref))) {
    problems.push(`${provider.id} has no saved key; save the OpenRouter key in Mori first`);
  }
  if (provider.zone === null) problems.push(`Zone of ${provider.id} is not confirmed; confirm it in v1 first (§14.1)`);
  return problems;
}

/**
 * @brief synthetic test setup（§14.1 的 2026-10-24 补，只改复制出的数据目录）：MP-40 加入用的地址 base（providerId 的
 *        Base URL；经 Add provider 新加时为 OPENROUTER_BASE）上不再有 NO_OFF_MODELS。地址是 base 的每个提供商里已有它们时
 *        先去掉（freeModel：还有别的模型时删掉，是唯一的模型时改名），再删掉复制出的 model-profiles.json 里它们在 base 上
 *        的档案。档案按地址存（§7.1），只动 base：别的地址上配着这两个模型的提供商留着自己的档案，启动时不会重新探测、
 *        多用免费模型每天的请求。删模型不删档案（ProfileBook 只按服务端模型替换），按原样再加入时指纹不变、不会重新
 *        探测（§7.1），补丁之前探测出错的旧档案会原样留着（§7.7"已经验证失败的模型"），所以档案也要删。
 * @param providerId OpenRouter 的提供商 id；要经 Add provider 新加时为 null
 * @return 改了什么（每项一句）
 */
export function prepareNoOff(userData, providerId) {
  const ids = Object.values(NO_OFF_MODELS);
  const notes = [];
  let base = OPENROUTER_BASE;
  editModelConfig(userData, (config) => {
    if (providerId) base = config.providers.find((item) => item.id === providerId).baseUrl;
    for (const provider of config.providers.filter((item) => item.baseUrl === base)) {
      for (const id of ids.filter((item) => provider.models.some((model) => model.id === item))) {
        notes.push(freeModel(config, provider.id, id));
      }
    }
  });
  const file = join(userData, 'model-profiles.json');
  if (!existsSync(file)) return notes;
  const data = readJson(file);
  const all = data.profiles ?? [];
  const kept = all.filter((profile) => !(ids.includes(profile.modelId) && profile.baseUrl === base));
  if (kept.length < all.length) {
    writeJson(file, { ...data, profiles: kept });
    notes.push(`dropped ${all.length - kept.length} stored profile(s) of ${ids.join(', ')} at ${base} from the `
      + 'copied model-profiles.json');
  }
  return notes;
}

/**
 * @brief 清单开着时只勾 ids（§6.2）：先 Clear selection，再对每个 id 在 Filter models 里填它、勾上它那一行，最后清空过滤。
 * @return { listed: 每个 id 过滤后那一行（id、能不能勾、Supports thinking）, picked: 清空过滤后勾着的 id,
 *          add: Add 按钮的文字与是否不可用, filter: 有没有过滤框, missing: 没列出或不能勾的 id }
 */
export async function tickModels(scope, ids) {
  const clear = scope.locator('[data-action="clear-selection"]');
  if (await clear.count()) await clear.click();
  const filter = scope.getByTestId('checklist-filter');
  const hasFilter = await filter.count() > 0;
  const listed = [];
  for (const id of ids) {
    if (hasFilter) await filter.fill(id);
    const row = (await readRows(scope)).find((item) => item.id === id);
    listed.push({ id, pickable: row?.pickable ?? false, reasoning: row?.reasoning ?? null });
    if (row?.pickable) await checklistRow(scope, id).locator('input[name="pick"]').check();
  }
  if (hasFilter) await filter.fill('');
  const picked = (await readRows(scope)).filter((row) => row.picked).map((row) => row.id);
  const { add } = await fetchedState(scope);
  const missing = listed.filter((row) => !row.pickable).map((row) => row.id);
  return { listed, picked, add, filter: hasFilter, missing };
}

/**
 * @brief 卡上的 Fetch models（用保存的 key，拉取规格 §6.5）→ tickModels → Add N models，等清单关掉、新模型的行都出现
 *        （或清单里出现加入失败的原文）。没列出或不能勾时关掉清单，不加入。
 * @return { state: 拉取之后的 fetchedState, ticked: tickModels 的结果（没有清单时 null）, providerId, error: 加入失败的原文 }
 */
export async function addOnCard(page, providerId, ids) {
  const card = cardOf(page, providerId);
  await card.scrollIntoViewIfNeeded();
  await card.locator('[data-action="fetch-models"]').click();
  const state = await waitFetched(card, FETCH_MS);
  const ticked = state.checklist ? await tickModels(card, ids) : null;
  if (!ticked || ticked.missing.length > 0) {
    const close = card.locator('[data-action="close-form"]');
    if (await close.count()) await close.click();
    return { state, ticked, providerId, error: null };
  }
  await card.locator('[data-action="add-models"]').click();
  const refs = ids.map((id) => `${providerId}/${id}`);
  const done = await page.waitForFunction(({ root, want }) => {
    const box = document.querySelector(root);
    const error = box?.querySelector('.card-checklist [data-testid="form-message"]');
    if (error) return { error: error.textContent };
    const rows = want.every((ref) => box?.querySelector(`[data-testid="model-row"][data-model="${ref}"]`));
    return rows && !box.querySelector('.card-checklist') ? { error: null } : false;
  }, { root: cardScope(providerId), want: refs }, { timeout: 30000 });
  return { state, ticked, providerId, error: (await done.jsonValue()).error };
}

/**
 * @brief 设置 → Models → Add provider：Base URL 填 OPENROUTER_BASE、key 输进密码框 → Fetch models → tickModels（只勾 ids）
 *        → 区域 Public → Add（addProviderUi）。没列出或不能勾时关掉表单，不加入。
 * @param key OpenRouter 的 key（只在内存里，只输进 Mori 的密码框）
 * @return addProviderUi 的结果，另有 ticked（tickModels 的结果，没有清单时 null）与 providerId（新的提供商；没有时 null）
 */
export async function addOpenRouter(page, key, ids) {
  let ticked = null;
  const choose = async (form, state) => {
    ticked = state.checklist ? await tickModels(form, ids) : null;
    return ticked && ticked.missing.length === 0 && ticked.picked.length > 0 ? ticked.picked : null;
  };
  const added = await addProviderUi(page, { baseUrl: OPENROUTER_BASE, key, choose });
  return { ...added, ticked, providerId: added.provider?.id ?? null };
}

/** @brief 清单底部 Add 按钮的文字（docs/v0/ui-strings.md："Add 1 model" / "Add N models"）。 */
export const addLabel = (count) => (count === 1 ? 'Add 1 model' : `Add ${count} models`);

/**
 * @brief MP-40 加入那一步不对的地方：拉取得到清单（Add provider 时有"Detected: OpenRouter"）；ids 都列出、能勾、
 *        标了 Supports thinking（服务列出了 reasoning）；只勾着它们、按钮 addLabel（"Add 1 model" / "Add N models"）；
 *        加入后配置里有它们并且 reasoning 为真；Add provider 时新的提供商是 OPENROUTER_BASE、Public、一个 key。
 * @param added addOnCard 或 addOpenRouter 的结果
 * @param provider 加入之后 models.get 里的这个提供商；没有时为 null
 * @param form 经 Add provider 加入时为真
 */
export function noOffAddProblems(added, provider, ids, form) {
  const { state, ticked } = added;
  const problems = [];
  if (!state.checklist || state.listError || state.commandError !== null) {
    problems.push(`fetch: ${JSON.stringify({ listError: state.listError, commandError: state.commandError })}`);
  }
  if (form && state.detected?.text !== 'Detected: OpenRouter') {
    problems.push(`Detected ${JSON.stringify(state.detected)}`);
  }
  for (const row of ticked?.listed ?? []) {
    if (!row.pickable) problems.push(`${row.id} is not listed or can't be ticked`);
    else if (row.reasoning !== true) problems.push(`${row.id} is listed without Supports thinking`);
  }
  if (ticked && [...ticked.picked].sort().join() !== [...ids].sort().join()) {
    problems.push(`ticked: ${ticked.picked.join(', ') || 'none'}`);
  }
  if (ticked && (ticked.add?.text !== addLabel(ids.length) || ticked.add.disabled)) {
    problems.push(`button ${JSON.stringify(ticked.add)}`);
  }
  if (added.error) problems.push(`Add failed: ${added.error}`);
  for (const id of ids) {
    const model = provider?.models.find((item) => item.id === id);
    if (!model) problems.push(`${id} is not saved`);
    else if (model.reasoning !== true) problems.push(`${id} is saved without Supports thinking`);
  }
  if (form && provider && (provider.baseUrl !== OPENROUTER_BASE || provider.zone !== 'public'
    || provider.keys.length !== 1)) {
    problems.push(`provider ${JSON.stringify({ baseUrl: provider.baseUrl, zone: provider.zone,
      keys: provider.keys.length })}`);
  }
  return problems;
}

/** @brief 模型行档案摘要里的 Thinking 一项（data-field="thinking_off"）：data-value 与文字；没有这一项时为 null。 */
export const thinkingOffItem = (page, ref) => modelRowOf(page, ref).evaluate((row) => {
  const item = row.querySelector('[data-field="thinking_off"]');
  return item ? { value: item.dataset.value ?? null, text: item.textContent } : null;
});

/**
 * @brief 模型行的 Test（connection.test，用第一个可用的 key）：点它，等这一行下面出现测试结果的文字。
 * @return 结果的文字；TEST_MS 内没有结果时为 null
 */
export async function testModelRow(page, ref) {
  const row = modelRowOf(page, ref);
  await row.scrollIntoViewIfNeeded();
  await row.locator('[data-action="test"]').click();
  return waitText(page, { root: `[data-testid="model-row"][data-model="${attr(ref)}"]`,
    css: '[data-testid="model-test"]', pattern: TEST_DONE }, TEST_MS);
}

/** @brief 设置页顶部"Back to app"，等设置页关掉（不等会话：可能还没有打开的会话）。 */
export async function leaveSettings(page) {
  await page.getByTestId('settings-page').getByRole('button', { name: 'Back to app' }).click();
  await page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: 10000 });
}

/**
 * @brief 当前一栏的 Effort 按钮（model-menu.md"界面测试用的标识"）：data-level、data-reasoning、读屏名（"Effort: <强度>"）、
 *        切换中、不可用；没有按钮时为 null。
 */
export function effortButton(page) {
  return page.evaluate((pane) => {
    const button = document.querySelector(`${pane} [data-testid="thinking-button"]`);
    return button ? { level: button.dataset.level ?? null, reasoning: button.dataset.reasoning ?? null,
      label: button.getAttribute('aria-label'), pending: button.dataset.pending === 'true',
      unavailable: button.getAttribute('aria-disabled') === 'true' } : null;
  }, PANE);
}

/**
 * @brief 打开当前一栏的 Effort 菜单读出强度项（data-level、aria-checked、不可用）与"This model can’t turn thinking off."
 *        一行（thinking-off-note），再按 Esc 关上。按钮不可用或切换中时不打开（levels 为空）；没有按钮时为 null。
 */
export async function effortMenu(page) {
  const button = await effortButton(page);
  if (!button || button.unavailable || button.pending) return button && { ...button, levels: [], note: null };
  await page.locator(`${PANE} [data-testid="thinking-button"]`).click();
  const menu = page.getByTestId('thinking-menu');
  await menu.waitFor({ timeout: 5000 });
  const items = await menu.evaluate((element) => ({
    levels: [...element.querySelectorAll('[role="menuitemradio"]')].map((item) => ({ level: item.dataset.level,
      checked: item.getAttribute('aria-checked') === 'true', disabled: item.disabled })),
    note: element.querySelector('[data-testid="thinking-off-note"]')?.textContent ?? null }));
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 5000 });
  return { ...button, ...items };
}

/** @brief 在当前一栏的 Effort 菜单里选 level，等按钮显示它、不再切换中。 */
export async function chooseEffort(page, level) {
  await page.locator(`${PANE} [data-testid="thinking-button"]`).click();
  await page.getByTestId('thinking-menu').locator(`[role="menuitemradio"][data-level="${level}"]`).click();
  await page.waitForFunction(({ selector, want }) => {
    const button = document.querySelector(`${selector} [data-testid="thinking-button"]`);
    return button?.dataset.level === want && button.dataset.pending !== 'true';
  }, { selector: PANE, want: level }, { timeout: 15000 });
}

/**
 * @brief 在当前一栏输入框下面一行的范围菜单里选 pick（模型范围是 <provider>/<model>），等范围按钮显示它、能用，
 *        Effort 按钮不再切换中（换范围的请求返回之前它也带 data-pending，ThinkingMenu.tsx）。
 */
export async function chooseRange(page, pick) {
  await page.locator(`${PANE} [data-testid="model-button"]`).click();
  await page.locator(`${PANE} [data-testid="model-menu"] [role="menuitemradio"][data-pick="${attr(pick)}"]`).click();
  await page.waitForFunction(({ selector, want }) => {
    const button = document.querySelector(`${selector} [data-testid="model-button"]`);
    const effort = document.querySelector(`${selector} [data-testid="thinking-button"]`);
    return button?.dataset.pick === want && !button.getAttribute('aria-disabled')
      && effort?.dataset.pending !== 'true';
  }, { selector: PANE, want: pick }, { timeout: 15000 });
}

/** @brief 会话文件里最后记下的思考强度（pi 的 thinking_level_change 条目）；没有时为 null。 */
export function thinkingRecorded(sessionFile) {
  if (!sessionFile || !existsSync(sessionFile)) return null;
  const entries = readFileSync(sessionFile, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'thinking_level_change');
  return entries.at(-1)?.thinkingLevel ?? null;
}

// ---------- key 方式：只经界面建数据目录（md-real.mjs 与 v1-models-real.mjs 共用；§14.1 的 2026-10-24 补，选项 A） ----------

/** key 方式的地址（md-real.mjs 另可用 MD_REAL_DEEPSEEK_URL、MD_REAL_GLM_URL 改；OpenRouter 的地址固定为 OPENROUTER_BASE） */
export const KEY_MODE_URLS = { deepseek: 'https://api.deepseek.com', glm: 'https://api.z.ai/api/anthropic' };
/** 一个模型的自动探针跑完的时限（免费模型慢） */
export const PROBE_MS = 15 * 60 * 1000;
/** 首次启动表单下方测试连接的结果（含保存失败）的开头（first-run.md 状态表） */
const FIRST_RUN_DONE = /^(Connected|Connection failed|Test cancelled|Couldn[’']t (save|test))/;

/** @brief 按键排序后的值（比较配置里的对象与数组用）。 */
const canon = (value) => (Array.isArray(value) ? value.map(canon) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canon(value[key])])) : value);
/** @brief 按键排序后比较。 */
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/**
 * @brief 把 key 输进 scope 里的 API key 框：先核对它是密码框（截图里只显示圆点），不是时不输入、抛错（错误里没有 key；
 *        调用方记成一条失败的 setup 检查）。
 */
export async function typeKey(scope, key) {
  const input = scope.getByLabel('API key', { exact: true });
  const type = await input.getAttribute('type');
  if (type !== 'password') throw new Error(`the API key field has type ${type}, not password; no key was typed`);
  await input.fill(key);
}

/** @brief 一个提供商保存下来的样子（检查的 detail 用；key 只有个数）。 */
export const providerBrief = (p) => (p ? { id: p.id, name: p.name, baseUrl: p.baseUrl, api: p.api, zone: p.zone,
  keys: p.keys.length, models: p.models.map((model) => model.id) } : null);

/** @brief 保存下来的提供商与界面填的、勾的对不上的地方（名称为地址的主机、API type 按地址，拉取规格 §3.4）。 */
export function savedProblems(provider, { baseUrl, models }) {
  if (!provider) return ['no provider was saved'];
  const want = { name: new URL(baseUrl).host, baseUrl, api: apiForUrl(baseUrl), zone: 'public', keys: 1, models };
  const got = providerBrief(provider);
  return Object.keys(want).filter((key) => !same(got[key], want[key]))
    .map((key) => `${key} ${JSON.stringify(got[key])}, want ${JSON.stringify(want[key])}`);
}

/**
 * @brief 首次启动表单（拉取规格 §6.6）：填 DeepSeek 的 Base URL 与 API key（typeKey）→ Fetch models → 只勾 DEEPSEEK_DOCS
 *        里服务列出的第一个模型 → Public → Test connection，等结果文字与这个模型的探针跑完（waitProbed：页面里要先装
 *        md-real-helpers.mjs 的 installRecorder）。
 * @param shot 截图（名字 → Promise；截之前由调用方查窗口的文字里有没有 key）
 * @return { state, rows, doc, picked（勾完之后勾着的 id）, text, provider, probed, probe }
 */
export async function firstRunDeepSeek(page, { baseUrl, key, shot }) {
  const form = page.getByTestId('connection-form');
  await form.getByLabel('Base URL', { exact: true }).fill(baseUrl);
  await typeKey(form, key);
  await form.locator('[data-action="fetch-models"]').click();
  const state = await waitFetched(form, FETCH_MS);
  const rows = await readRows(form);
  await shot('setup-first-run');
  const doc = DEEPSEEK_DOCS.models.find((item) => rows.some((row) => row.id === item.id && row.pickable)) ?? null;
  if (!doc) return { state, rows, doc, picked: [], text: null, provider: null, probed: false, probe: null };
  await pickOnly(form, doc.id);
  const picked = (await readRows(form)).filter((row) => row.picked).map((row) => row.id);
  await form.locator('input[name="zone"][value="public"]').check();
  const since = Date.now() - 1000;
  await form.locator('[data-action="test"]').click();
  const text = await waitText(page, { root: '[data-testid="connection-form"]',
    css: '[data-testid="form-message"]', pattern: FIRST_RUN_DONE }, TEST_MS);
  const provider = (await modelsGet(page)).config.providers[0] ?? null;
  const connected = Boolean(text?.startsWith('Connected')) && provider !== null;
  const probed = connected && await waitProbed(page, `${provider.id}/${doc.id}`, since, PROBE_MS);
  await shot('setup-first-run-tested');
  return { state, rows, doc, picked, text, provider, probed, probe: await probeStatus(page) };
}

/**
 * @brief 首次启动接 DeepSeek（firstRunDeepSeek 的结果）不对的地方：清单与"Detected: DeepSeek"、只勾着文档的那个模型、
 *        测试连接连上、保存下来的提供商（savedProblems）、探针跑完并且工具调用已验证。
 * @param baseUrl 填的 Base URL
 */
export function firstRunProblems(run, baseUrl) {
  const { state, doc, provider, picked } = run;
  return [
    ...(state.checklist && !state.listError && state.commandError === null ? [] : ['no checklist']),
    ...(state.detected?.text === 'Detected: DeepSeek' ? [] : [`Detected ${brief(state.detected)}`]),
    ...(doc ? [] : ['the server lists no model of DEEPSEEK_DOCS']),
    ...(doc && !same(picked, [doc.id]) ? [`ticked: ${picked.join(', ') || 'none'}`] : []),
    ...(run.text?.startsWith('Connected') ? [] : [`test result ${run.text}`]),
    ...(doc ? savedProblems(provider, { baseUrl, models: [doc.id] }) : []),
    ...(run.probed && run.probe?.state === 'verified' ? [] : [`probes ${run.probed ? 'done' : 'not done'}, `
      + `probe status ${brief(run.probe)}`]),
  ];
}

/**
 * @brief 设置 → Models → Add provider（拉取规格 §6.1）：Base URL 与 API key（typeKey）→ Fetch models →
 *        choose(form, state, rows) 只勾要的行（返回勾上的，勾不成时 null，这时关掉表单）→ Public → Add，等表单关掉、
 *        新卡出现。
 * @return { state, rows, picked, provider（新的提供商；没有时 null）, since（点 Add 前的时刻）, error（表单里的原文） }
 */
export async function addProviderUi(page, { baseUrl, key, choose }) {
  const before = await cardIds(page);
  await page.locator('[data-action="add-provider"]').click();
  const form = page.getByTestId('provider-form');
  await form.getByLabel('Base URL', { exact: true }).fill(baseUrl);
  await typeKey(form, key);
  await form.locator('[data-action="fetch-models"]').click();
  const state = await waitFetched(form, FETCH_MS);
  const rows = await readRows(form);
  const picked = await choose(form, state, rows);
  const since = Date.now() - 1000;
  if (!picked) {
    await form.locator('[data-action="close-form"]').click();
    return { state, rows, picked, provider: null, since, error: null };
  }
  await form.locator('input[name="zone"][value="public"]').check();
  await form.locator('[data-action="add-models"]').click();
  const closed = await form.waitFor({ state: 'detached', timeout: 30000 }).then(() => true, () => false);
  const error = closed ? null : await form.getByTestId('form-message').textContent().catch(() => null);
  const after = closed ? await pollFor(() => cardIds(page), (ids) => ids.length > before.length, 15000) : before;
  const id = after.find((item) => !before.includes(item));
  const provider = (await modelsGet(page)).config.providers.find((item) => item.id === id) ?? null;
  return { state, rows, picked, provider, since, error };
}

/** @brief 只勾 id 这一行，读回勾着的：只有它时返回 id，否则 null。 */
export async function tickOnly(form, id) {
  await pickOnly(form, id);
  const picked = (await readRows(form)).filter((row) => row.picked).map((row) => row.id);
  return same(picked, [id]) ? id : null;
}

/** @brief GLM：服务列出了 GLM-5.3 时只勾那一行；没列出时（或列表错误）用 Add a model ID 手填，手填的行勾上（§6.4）。 */
export async function chooseGlm(form, state, rows) {
  if (rows.some((row) => row.id === GLM_MANUAL_ID)) return tickOnly(form, GLM_MANUAL_ID);
  if (state.checklist) await form.locator('[data-action="clear-selection"]').click();
  await addModelId(form, GLM_MANUAL_ID);
  const picked = (await readRows(form)).filter((row) => row.picked).map((row) => row.id);
  return same(picked, [GLM_MANUAL_ID]) ? GLM_MANUAL_ID : null;
}

/**
 * @brief 一次 Add provider（addProviderUi，choose 返回一个 id）不对的地方：拉取的结果（detected 给出时 Detected 一行的文字，
 *        §6.1）、勾选、表单的原文与保存下来的提供商。
 */
export function addedProblems(added, baseUrl, detected = null) {
  const { state, picked } = added;
  return [
    ...(state.commandError === null && !state.cancelled && (state.checklist || state.listError) ? []
      : [`fetch: ${brief({ commandError: state.commandError, cancelled: state.cancelled })}`]),
    ...(detected && state.detected?.text !== detected ? [`Detected ${brief(state.detected)}`] : []),
    ...(picked ? [] : ['the wanted row could not be ticked alone']),
    ...(added.error ? [`Add failed: ${added.error}`] : []),
    ...(picked ? savedProblems(added.provider, { baseUrl, models: [picked] }) : []),
  ];
}

/**
 * @brief Add provider 接 GLM（addProviderUi + chooseGlm 的结果）不对的地方：z.ai 的 Anthropic 兼容列表拿到时 Detected 写
 *        Anthropic-compatible server（拉取规格更正 4，§3.2、§3.3）；列表错误时没有 Detected 一行（§6.1）。
 */
export function glmAddProblems(glm, baseUrl) {
  const detected = glm.state.checklist ? 'Detected: Anthropic-compatible server' : null;
  return [...addedProblems(glm, baseUrl, detected),
    ...(glm.state.listError && glm.state.detected ? [`Detected with a list error ${brief(glm.state.detected)}`] : [])];
}
