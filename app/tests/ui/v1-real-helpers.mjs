// v1 模型层的真实走查与录制（v1-models-real.mjs、v1-models-record.mjs）共用的准备与操作，做法按
// docs/specs/model-providers.md §14.1"真实模型与录制"：
// 1. 复制数据目录：只复制加密的 credentials.json、Electron 的 Local State（解密要用）、model-config.json、
//    model-profiles.json 和 pi/settings.json（按模型的思考强度）；不复制 pi/models.json，从不读取或打印 key。
// 2. 测试准备（synthetic test setup，写在复制出的 model-config.json 里）：建一个分组 [首选提供商, 第二个提供商] 作为默认范围，
//    给临时项目授权公网（projectZones）；把首选提供商第一个 key 的密文原样另存到一个备用 ref（只复制密文字符串）。
// 3. 故障用真实方式触发：在界面里给首选提供商加一个错的 key（sk-invalid），再删掉原来的 key，之后的请求得到真实的 401。
// 4. 恢复：退出 App 后把配置里首选提供商的 key 改指备用 ref（并把备份的密文写回这个 ref：在界面里删掉这个 key 时
//    App 会删掉它的密文），重新启动。
// 只读页面和磁盘，不记录检查结果（由调用方记录）。

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { sleep } from './lib.mjs';
import { PANE, stubFolder, waitReady } from './m3-helpers.mjs';

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
    && looksLike(provider, /glm|bigmodel|zhipu/i));
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

/** @brief 打开一个项目文件夹（系统对话框换成直接返回它），等会话就绪。 */
export async function openProjectFolder(app, page, project) {
  await stubFolder(app, project);
  await page.getByTestId('sidebar').getByRole('button', { name: 'Open folder…', exact: true }).click();
  await waitReady(page);
}

/** @brief 当前一栏的会话文件（侧栏里选中的一行）；没有时为 null。 */
export const activeSessionFile = (page) => page.locator('.session-item.active').first()
  .getAttribute('data-file', { timeout: 5000 }).catch(() => null);

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

/** @brief 当前一栏顶栏的范围按钮：文字、data-pick、data-current、是否可用、悬停说明。 */
export function rangeButton(page) {
  return page.evaluate((pane) => {
    const button = document.querySelector(`${pane} [data-testid="model-button"]`);
    if (!button) return null;
    return { text: button.textContent.replace(/▾/g, '').trim(), pick: button.dataset.pick ?? null,
      current: button.dataset.current ?? null, disabled: button.disabled, title: button.getAttribute('title') };
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

/** 合理的探针结果允许的取值（§7.2） */
const FIELDS = ['reasoning_content', 'reasoning', 'reasoning_text', 'none', 'native'];
const SERVERS = ['vllm', 'sglang', 'ollama', 'llamacpp', 'unknown'];

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
