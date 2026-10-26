// 一键拉取模型的回放测试（docs/specs/model-discovery.md §13.1 的回放层；§13.2 的 MD-07、MD-13，以及 §13.4 回放桥一行，
// 记作 MD-15）：在 Electron 里载入真正的界面，用回放进程桥（tests/ui/harness）回放 md-record.mjs 从真实的 App 录下的
// tests/fixtures/discovery/ui/*.json（md-openrouter、md-glm 是真实录制；md-deepseek 对合成端点录下，source 为 synthetic，
// 直到 MD-14 用负责人的 key 录下真实的 DeepSeek）。测试像你一样操作：设置 → Models → Add provider，填录制里的 Base URL，
// Fetch models（回放桥按地址用录下的 models.discover 结果回答），在清单里勾选、过滤、改值，Add；卡上的 Fetch models 与 Add；
// 模型行提示的 Use。界面发出的写命令由回放桥直接应答（status.modelWrites），测试拿它与录制里的命令、或按规格独立算出的
// 命令比较；期望的文字、勾选与提示由录下的结果按规格 §6.2、§6.3、§8 独立算出，不从 src/ 引用。
//   md-openrouter（MD-07）：真实的几百行清单：标题、默认勾选、Default（改了值就不标）、no_tools 提示、过滤框（不分
//     大小写）、Select all 与 Clear selection 只作用于显示着的行、Add 的文字随勾选数变、被过滤框藏起来的勾选行照样加入。
//   md-glm（MD-07、MD-15）：真实的列表错误（服务拒绝）的两句，没有清单的标题、Select all、Clear selection 和过滤框；
//     在 API key 框填了一个 synthetic 的 key，回放桥照样按地址用录下的结果回答（key 不参与配对）。
//   md-deepseek（MD-07、MD-13、MD-15）：DeepSeek 式清单（类型不明、多行时都不勾，不超过 20 行时没有过滤框，Select all，
//     改值的检查与错误时 Add 不可用、只有勾选的行的错误挡住 Add，改窗口时 Max output 随之变，Add 发出的命令与录制的相同）；
//     typed 清单（chat 真的勾上、假的不勾并写 Not a chat model，Default 只在值仍是默认值时，没报告的 Max output 随窗口变）；
//     加入后设置页的模型行（录下的档案：(default)、§8 表的五种提示与 Use 的改动，含窗口改回报告值时 Max output 一起
//     改小，旧档案只有第四种）；Legacy endpoint 卡上的 Fetch models（已加入的行标 Added、不能勾也不能改，
//     能加入的只有一行时默认勾上，Clear selection 与 Select all 只作用于能勾的行，Add 发 models.addModels）。回放桥：设置页
//     先是录下的 models.get，每次加入后按写命令的条数换成录制里的下一个；models.addModels 照其他写命令应答。
//   md-shapes（MD-07、MD-13；对合成端点录下，source 为 synthetic）：id 含空格的行（Can’t add this model，只有勾选框
//     不可用；能加入的只有另一行，默认勾上；Select all 不勾它）；空列表的一句（Models (0)，下面是 Add a model ID）；
//     Ollama 的清单（服务报告类型的行都勾上、trained_window 与 no_tools 两种提示、改窗口时没报告的 Max output 随之变，
//     Add 发出录制的命令）；加入后的模型行（训练窗口不写 (default)、没有窗口的提示；改小过窗口的行有窗口的提示）；
//     Use 发出录制的 models.saveModel，提示消失，之后行上的 data-probe 照录下的重新探测变为 reverifying（2026-10-26 起
//     能用的模型重新验证时没有状态行、不写 Re-verifying…），最后是 verified，录下的最后一个档案的 probedAt 比 Use 之后读到的新。
//     回放桥直接应答设置页的 models.* 写命令，不回放事件（它只在界面主动发出的命令之后回放事件，§13.4）：测试在页面
//     载入前（addInitScript）记下界面经 window.mori.onEvent 挂上的监听，Use 之后把录制里 Use 之后后台进程转发的事件
//     原样、按顺序交给它们（captureListeners、feedEvent），每个事件之后读一次 Tool calling。
//   md-*-card（MD-07、MD-13）：md-real.mjs 用卡上保存的 key（--source 的数据目录，或按负责人的 key 经界面新建的数据目录），
//     从真实的 App 对真实的服务录下的卡上拉取
//     （md-deepseek-card、md-glm-card）。tests/fixtures/discovery/ui/ 里有几份就回放几份（这些文件就是数据，同其他录制；
//     一份都没有时不记检查）。设置页先是录制里卡上拉取之前的 models.get（模型行的 (default) 与 §8 的提示照它的
//     档案）；卡上的 Fetch models（回放桥按提供商用录下的 models.discover 回答）之后的期望全部由录下的结果独立算出：
//     默认勾选（chat、Added、unusable）、Default 按录下的 reported 与值、标记与提示、Models (N)、过滤框与截断说明、
//     卡里没有 Detected 一行；拉取时已在提供商里的 id（按那个 models.get 的配置）标 Added；Not listed 一行；有
//     listError 时 §6.3 的两句。录制里有界面发的 models.addModels（md-real.mjs 记下、按配置的变化核对过）时照它勾选、
//     改值（改了窗口的行检查 Max output 按 §4.3 随之变），Add 发出同样的命令；加入后的模型行照录制里加入之后最后一个
//     models.get 的档案。
// 上面四份录制文件（md-openrouter、md-glm、md-deepseek、md-shapes）还不存在时，每个对应编号记一条失败
// "<编号> replay fixture missing"（不造假录制）；--only 里的名字不是其中之一、也没有那份 md-*-card.json 时记一条失败。
// 用法（在 app/ 下）：node tests/ui/md-replay.mjs [--only md-openrouter,md-glm,md-deepseek,md-shapes,<md-*-card 的名字>]
// 结果写到 test-results/md-replay.json（--only 时 md-partial-replay.json，不计入覆盖检查）；截图在 test-results/md-replay/。
// 2026-10-26（WP-02，负责人走查 M6、M7）：清单的"Not reported"与模型行的"(not reported)"改为"Default""(default)"，只在值
// 仍是 Mori 的默认值时标（改成别的值就不标、改回又标）；上面的写法已照这条改过。模型行
// 没有档案摘要：Tool calling 改读行上的 data-probe 和状态行（能用的模型没有状态行）。trained_window 的提示改短。
// 2026-10-26（WP-15，负责人走查回答 1，规格 §4.4、§6.2、§8，MD-17）：服务没报告、按地址取自 pi 模型表的值，清单写
// "From pi"、模型行写"(from pi)"，悬停写 pi 的提供商名；仍是默认值的模型行多三种 pi 的提示。期望照录下的 catalog
// （DiscoveredModel.catalog、ProfileView.catalog）独立算出，所有清单行与模型行的比较都含这两种标记。卡上的录制
// md-glm-pi-card（md-real.mjs --only glm-pi 录：z.ai 卡上的清单与加入一个取自 pi 的模型）另查 MD-17：取自 pi 的行与
// 悬停、改窗口后 From pi 消失、Max output 跟着变、改回又有；加入后的模型行写 (from pi)。这份录制不存在（不带 --only 时）
// 或里面没有取自 pi 的值时记失败。改动之前录的 md-glm-card、md-openrouter 没有 catalog，按"没有取自 pi 的值"比较，
// 集成时重录。2026-10-26 审查后补：md-glm-pi-card 里在 Add a model ID 填一个 pi 的模型表里这个地址有、列表里没有的 id
// （测试自己从 pi-ai 读），这一行写 Default、不写 From pi；加入后照录制点模型行上 pi 的提示的 Use（录下的
// models.saveModel），每次之后模型行与录下的 models.get 一致，点过的含 pi 的三种提示，你设过的 Max output 没有 pi 的提示。
// md-openrouter-first-run（synthetic：md-openrouter 的真实列表放进首次启动表单，harness/main.jsx 的
// synthetic-openrouter-first-run 只把 config.get 改成首次启动）：首次启动表单的清单里取自 pi 的行写 From pi，手填的行不写。
// md-deepseek-pi-thinking（synthetic：md-deepseek 最后的设置页，一个探针读到推理字段的档案补了只有思考为真的 catalog，
// harness/main.jsx 的 synthetic-deepseek-pi-thinking）：§8 表第四行在 pi 的思考提示出现时不出。
// md-deepseek-no-profile（MD-18，2026-10-26 补；synthetic：md-deepseek 最后的设置页，一个模型的档案去掉，harness/main.jsx 的
// synthetic-deepseek-no-profile）：没有档案、不在探测的模型行是“Couldn’t verify”加 Verify again，点它发 models.verify；回放桥
// 让这条写命令失败（replay.js 的 failModelWrite）时原文写在这一行里。
// md-glm-pi-card 另查取消勾选取自 pi 的 Supports thinking 后不写 From pi、再勾上又写；md-openrouter-first-run 另查同一格的值
// 同时是 pi 的值与默认值时只写 From pi（2026-10-26 补，WP-15 的状态表各行）。

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import { _electron as electron } from 'playwright-core';
import { appRoot, arg, createRecorder, oneLine, sleep } from './lib.mjs';
import { piEntriesAt } from './md-real-helpers.mjs';

const only = arg('only')?.split(',');
const harnessDir = join(appRoot, 'tests/ui/harness');
const outDir = join(appRoot, 'test-results/harness-md');
const fixtureDir = join(appRoot, 'tests/fixtures/discovery/ui');
const resultFile = only ? 'md-partial-replay.json' : 'md-replay.json';
const shots = join(appRoot, 'test-results/md-replay');
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder('replay harness');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

// ---------- 规格里的文字（独立实现） ----------

/** §6.3 列表错误的一句 */
const LIST_ERROR = {
  rejected: (detail) => `The server rejected the API key: ${detail}`,
  unreachable: (detail, host) => `Couldn’t reach ${host}: ${detail}`,
  no_list: () => 'This server doesn’t list its models.',
  invalid: (detail) => `Couldn’t read the model list: ${detail}`,
};
const STILL = 'You can still add model IDs below.';
/** §6.2 行上的提示 */
const HINT_TEXT = { no_tools: 'The server doesn’t list tool support for this model.',
  trained_window: 'Trained context window. Ollama may use a smaller one.' };
/** §6.2 Context window、Max output 的字段错误（模型层的同一组文字） */
const WINDOW_ERROR = 'Context window must be a whole number above 0.';
const MAX_ERROR = 'Max output must be smaller than the context window.';
/** §8 表的五种提示，按表的顺序 */
const HINT_KINDS = ['context', 'max-output', 'reasoning', 'thinking-seen', 'image'];
/** 回放时在 GLM 的 API key 框里填的 key（synthetic，不发往任何服务） */
const SYNTHETIC_KEY = 'synthetic-replay-key';

/** @brief §6.1 第 8 项：Add 1 model / Add N models；勾选数为 0 时 Add models。 */
const addLabel = (n) => (n === 0 ? 'Add models' : n === 1 ? 'Add 1 model' : `Add ${n} models`);
/** @brief 千分位（模型行的数字，§8）。 */
const fmt = (n) => n.toLocaleString('en-US');
/** @brief 没报告时的输出上限：16384 与窗口一半中较小的（§4.3、§11）。 */
const unreportedMax = (window) => Math.min(16384, Math.floor(window / 2));
/** 没报告时的窗口（§11） */
const UNREPORTED_WINDOW = 128000;
/**
 * @brief 标"Default"/"(default)"的字段（§6.2、§8，2026-10-26 起）：服务没报告、而且值仍等于默认值（窗口 128000；
 *        Max output 为按当前窗口算的默认值）。
 * @param unreported { contextWindow, maxTokens }：服务没报告这一项
 */
const defaultFields = (unreported, window, max) => [
  ...(unreported.contextWindow && window === UNREPORTED_WINDOW ? ['contextWindow'] : []),
  ...(unreported.maxTokens && max === unreportedMax(window) ? ['maxTokens'] : [])];
/** §6.2：清单里取自 pi 的值旁边的字 */
const FROM_PI = 'From pi';
/** @brief §6.2 清单里"From pi"的悬停说明（2026-10-26）。 */
const piListTitle = (provider) => `The server didn’t report this, so Mori used pi’s model list for ${provider}. `
  + 'Change it if you know the real value.';
/** @brief §8 模型行里"(from pi)"的悬停说明（2026-10-26；审查后改为只说与 pi 的值相同）。 */
const piRowTitle = (provider) => `The server didn’t report this; pi’s model list for ${provider} has the same value. `
  + 'Use Edit to set the real value.';
/** 规格 §4.4 取自 pi 的三项（标记的 data-field） */
const PI_FIELDS = ['contextWindow', 'maxTokens', 'reasoning'];
/** md-real.mjs --only glm-pi 录下的卡上录制（MD-17 的回放层） */
const PI_CARD = 'md-glm-pi-card';
/** §8 表后三行（pi 的提示）的 data-kind */
const PI_KINDS = ['pi-context', 'pi-max-output', 'pi-reasoning'];
/** md-openrouter 的真实列表放进首次启动表单（synthetic，harness/main.jsx 的 openrouterFirstRun） */
const FIRST_RUN = 'synthetic-openrouter-first-run';
/** md-deepseek 最后的设置页、一个档案补了取自 pi 的 catalog（synthetic，harness/main.jsx 的 deepseekPiThinking） */
const PI_THINKING = 'synthetic-deepseek-pi-thinking';
/** PI_THINKING 里补了 catalog 的模型（同 harness/main.jsx） */
const PI_THINKING_REF = '127-0-0-1-4860/fake-ds-alwaysthink';
/** md-deepseek 最后的设置页、去掉一个已配置模型的档案（synthetic，harness/main.jsx 的 deepseekNoProfile，2026-10-26 补） */
const NO_PROFILE = 'synthetic-deepseek-no-profile';
/** NO_PROFILE 里没有档案的模型（同 harness/main.jsx 的 NO_PROFILE_REF） */
const NO_PROFILE_REF = '127-0-0-1-4860/fake-ds-alwaysthink';
/** 回放桥让 Verify again 的 models.verify 以这段原文失败（synthetic，replay.js 的 control.failModelWrite） */
const VERIFY_FAILURE = 'Synthetic models.verify failure (replay)';
/** @brief 录下的 DiscoveredModel 里取自 pi 的项（§5.2 catalog；改动之前的录制没有这个字段，算没有）。 */
const piOf = (m) => (m.catalog ? PI_FIELDS.filter((field) => m.catalog[field]) : []);
/** @brief 两个值的 JSON 相同。 */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** @brief 检查的 detail。 */
const brief = (value, max = 1500) => oneLine(typeof value === 'string' ? value : JSON.stringify(value), max);

/** @brief 按键名排序后的 JSON（同回放桥：命令里键的先后不计）。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * @brief 清单每一行该显示的（§6.2，独立实现）：默认勾选、能不能勾、能不能改（Added 的行不能改）、两个数字、两个勾选框、
 *        Default（没报告且值仍是默认值，2026-10-26）、标记与提示。
 * @param models 录下的 DiscoverResult.models
 */
function expectRows(models) {
  const usable = models.filter((m) => !m.added && m.unusable === null).length;
  return models.map((m) => ({ id: m.id, chat: m.chat === null ? 'unknown' : String(m.chat),
    picked: !m.added && m.unusable === null && (m.chat ?? usable === 1), pickDisabled: m.added || m.unusable !== null,
    locked: m.added, window: String(m.contextWindow), max: String(m.maxTokens), reasoning: m.reasoning, image: m.image,
    // 取自 pi 的项写 From pi、不写 Default（§6.2，2026-10-26）
    defaults: defaultFields({ contextWindow: !m.reported.contextWindow && !piOf(m).includes('contextWindow'),
      maxTokens: !m.reported.maxTokens && !piOf(m).includes('maxTokens') }, m.contextWindow, m.maxTokens),
    pi: piOf(m),
    tags: [...(m.chat === false ? [{ kind: 'not-chat', text: 'Not a chat model' }] : []),
      ...(m.added ? [{ kind: 'added', text: 'Added' }] : []),
      ...(m.unusable !== null ? [{ kind: 'unusable', text: `Can’t add this model: ${m.unusable}` }] : [])],
    hints: m.hints.map((kind) => ({ kind, text: HINT_TEXT[kind] })) }));
}

/** @brief 清单行转成配置里的模型（§6.2：Family 按服务的 family 原样保存）。 */
const modelOf = (m, patch = {}) => ({ id: m.id, family: m.family, contextWindow: m.contextWindow,
  maxTokens: m.maxTokens, reasoning: m.reasoning, input: m.image ? ['text', 'image'] : ['text'], ...patch });

/**
 * @brief 模型行该有的提示（§8 的表，独立实现），按表的顺序：kind、文字、Use 保存的模型。
 * @param profile 这个模型的档案（ProfileView）；还没有时为 undefined
 */
function expectHints(api, model, profile) {
  const reported = profile?.reported ?? null;
  const out = [];
  const add = (kind, text, patch) => out.push({ kind, text, model: { ...model, ...patch } });
  const n = reported?.contextWindow ?? null;
  if (n !== null && n !== model.contextWindow) {
    add('context', `Server reports a context window of ${fmt(n)}.`,
      { contextWindow: n, maxTokens: model.maxTokens >= n ? unreportedMax(n) : model.maxTokens });
  }
  const m = reported?.maxTokens ?? null;
  if (m !== null && m !== model.maxTokens && m < model.contextWindow) {
    add('max-output', `Server reports max output of ${fmt(m)}.`, { maxTokens: m });
  }
  if (reported?.reasoning === true && !model.reasoning) {
    add('reasoning', 'The server says this model supports thinking.', { reasoning: true });
  }
  if (api === 'openai-completions' && profile && profile.reasoning.field !== 'none' && !model.reasoning
    && reported?.reasoning !== true) {
    add('thinking-seen', 'This model returned thinking content.', { reasoning: true });
  }
  if (reported?.image === true && !model.input.includes('image')) {
    add('image', 'The server says this model accepts images.', { input: ['text', 'image'] });
  }
  out.push(...piHints(model, profile?.catalog ?? null));
  return out.filter((hint) => hint.kind !== 'thinking-seen' || profile?.catalog?.reasoning !== true);
}

/**
 * @brief §8 表的后三行（2026-10-26，WP-15）：档案的 catalog（取自 pi 的值）与配置不同，且配置的值仍是 Mori 的默认值。
 * @param catalog 档案的 catalog；改动之前的录制没有这个字段，为 null
 */
function piHints(model, catalog) {
  if (!catalog) return [];
  const out = [];
  const lead = `pi’s model list for ${catalog.provider}`;
  const add = (kind, text, patch) => out.push({ kind, text, model: { ...model, ...patch } });
  const n = catalog.contextWindow;
  if (n !== null && n !== model.contextWindow && model.contextWindow === UNREPORTED_WINDOW) {
    add('pi-context', `${lead} has a context window of ${fmt(n)}.`,
      { contextWindow: n, maxTokens: model.maxTokens >= n ? unreportedMax(n) : model.maxTokens });
  }
  const m = catalog.maxTokens;
  if (m !== null && m !== model.maxTokens && m < model.contextWindow
    && model.maxTokens === unreportedMax(model.contextWindow)) {
    add('pi-max-output', `${lead} has max output of ${fmt(m)}.`, { maxTokens: m });
  }
  if (catalog.reasoning && !model.reasoning) {
    add('pi-reasoning', `${lead} says this model supports thinking.`, { reasoning: true });
  }
  return out;
}

/**
 * @brief 模型行上标"(from pi)"的项（§8，2026-10-26）：档案的 catalog 有这一项，并且配置的值等于它（Supports thinking
 *        为勾着）。
 */
function rowPi(model, profile) {
  const catalog = profile?.catalog ?? null;
  if (!catalog) return [];
  return [...(catalog.contextWindow !== null && catalog.contextWindow === model.contextWindow ? ['contextWindow'] : []),
    ...(catalog.maxTokens !== null && catalog.maxTokens === model.maxTokens ? ['maxTokens'] : []),
    ...(catalog.reasoning && model.reasoning ? ['reasoning'] : [])];
}

/**
 * @brief 模型行上标"(default)"的字段（§8，2026-10-26）：档案有报告值、这一项没报告、配置的值仍是默认值；
 *        标了"(from pi)"的项不再标（WP-15）。
 */
function rowDefaults(model, profile) {
  const reported = profile?.reported ?? null;
  const pi = rowPi(model, profile);
  return reported === null ? [] : defaultFields({
    contextWindow: reported.contextWindow === null && !pi.includes('contextWindow'),
    maxTokens: reported.maxTokens === null && !pi.includes('maxTokens') }, model.contextWindow, model.maxTokens);
}

/** @brief 模型行说明的开头（§8）：窗口与 Max output，没报告且仍是默认值的后面写 (default)，取自 pi 的写 (from pi)。 */
function metaStart(model, profile) {
  const marks = rowDefaults(model, profile);
  const pi = rowPi(model, profile);
  const nr = (field) => (pi.includes(field) ? ' (from pi)' : marks.includes(field) ? ' (default)' : '');
  return `Context window: ${fmt(model.contextWindow)}${nr('contextWindow')} · Max output: `
    + `${fmt(model.maxTokens)}${nr('maxTokens')}`;
}

// ---------- 录制 ----------

/** @brief 读一个录制文件。 */
const readFixture = (name) => JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), 'utf8'));
/** @brief 某种命令的结果与它的命令（结果是它之前最近一条同类型命令的），按顺序。 */
function pairs(steps, type) {
  const out = [];
  steps.forEach((step, index) => {
    if (step.result?.type !== type || step.result.error) return;
    const command = steps.slice(0, index).findLast((s) => s.command?.type === type)?.command;
    out.push({ command, value: step.result.value });
  });
  return out;
}
/** @brief 改配置的 models.* 写命令（不含读取与 models.discoverCancel）。 */
const configWrite = (type) => type.startsWith('models.') && !['models.get', 'models.reload', 'models.discover',
  'models.discoverCancel'].includes(type);
/** @brief 录制里的改配置写命令，按顺序。 */
const writesOf = (fx) => fx.steps.filter((s) => s.command && configWrite(s.command.type)).map((s) => s.command);
/** @brief 录制里在第 writes 条写命令之后、下一条之前录下的最后一个 models.get（界面这时该显示的设置页）。 */
function stateAfter(fx, writes) {
  let count = 0;
  let found = null;
  for (const step of fx.steps) {
    if (step.command && configWrite(step.command.type)) count += 1;
    if (count <= writes && step.result?.type === 'models.get' && !step.result.error) found = step.result.value;
  }
  return found;
}

// ---------- 页面 ----------

/** @brief 构建回放页面（到 test-results/harness-md，不碰 out/）。 */
async function buildHarness() {
  await build({ root: harnessDir, base: './', configFile: false, logLevel: 'warn', plugins: [react()],
    build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 10_000 } });
}

/** @brief 载入录制文件，等侧栏读完会话列表；再点侧栏的 Settings，等 Models 的 Providers 一节。 */
async function load(page, name) {
  const index = pathToFileURL(join(outDir, 'index.html')).href;
  await page.goto(`${index}?fixture=${name}&speed=4&maxGap=600`);
  await page.getByTestId('session-tree').waitFor({ state: 'attached', timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.sidebar-note'), null, { timeout: 20000 });
  await page.getByTestId('sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('providers').waitFor({ timeout: 10000 });
}

/** @brief 回放桥记下的写命令（status.modelWrites）。 */
const writes = (page) => page.evaluate(() => window.__replay.status.modelWrites);
/** @brief 设置页上的提供商卡（data-provider，按顺序）。 */
const cards = (page) => page.locator('[data-testid="provider-card"]').evaluateAll((items) => items
  .map((el) => el.dataset.provider));

/**
 * @brief 清单此刻的样子（scope 为 Add provider 表单或提供商卡的选择器）：标题、Select all / Clear selection / 过滤框、
 *        截断说明、列表错误、每一行（勾选、数字、勾选框、Default、标记、提示、字段错误）与 Add 按钮；另有
 *        Not listed 一行与 Detected 一行的文字（没有时为 null），以及有没有空列表的一句。
 *        Default 记它的 data-field；文字不是"Default"时记成"<field>=<文字>"，与期望的比较时不相等。
 */
const checklistOf = (page, scope) => page.evaluate((root) => {
  const base = document.querySelector(root);
  const box = base?.querySelector('[data-testid="checklist"]');
  const error = base?.querySelector('[data-testid="list-error"]');
  const filter = base?.querySelector('[data-testid="checklist-filter"]');
  const add = base?.querySelector('[data-action="add-models"]');
  const texts = (el, sel) => [...el.querySelectorAll(sel)].map((x) => ({ kind: x.dataset.kind, text: x.textContent }));
  const marker = (x) => (x.textContent === 'Default' ? x.dataset.field : `${x.dataset.field}=${x.textContent}`);
  // From pi（2026-10-26）：同 marker，文字不是"From pi"时记成"<field>=<文字>"
  const piMarker = (x) => (x.textContent === 'From pi' ? x.dataset.field : `${x.dataset.field}=${x.textContent}`);
  const rows = [...(base?.querySelectorAll('[data-testid="discovered-row"]') ?? [])].map((tr) => {
    const pick = tr.querySelector('input[name="pick"]');
    const value = (field) => tr.querySelector(`input[data-field="${field}"]`);
    return { id: tr.dataset.model, chat: tr.dataset.chat, picked: pick.checked, pickDisabled: pick.disabled,
      label: pick.getAttribute('aria-label'), window: value('contextWindow').value, max: value('maxTokens').value,
      reasoning: value('reasoning').checked, image: value('image').checked,
      locked: ['contextWindow', 'maxTokens', 'reasoning', 'image'].every((field) => value(field).disabled),
      defaults: [...tr.querySelectorAll('[data-testid="default-value"]')].map(marker),
      pi: [...tr.querySelectorAll('[data-testid="pi-value"]')].map(piMarker),
      piTitles: [...tr.querySelectorAll('[data-testid="pi-value"]')].map((x) => x.title),
      tags: texts(tr, '[data-testid="row-tag"]'), hints: texts(tr, '[data-testid="row-hint"]'),
      errors: [...tr.querySelectorAll('[data-testid="field-error"]')].map((x) => ({ field: x.dataset.field,
        text: x.textContent })) };
  });
  return { title: box?.querySelector('h4')?.textContent ?? null,
    selectAll: Boolean(base?.querySelector('[data-action="select-all"]')),
    clear: Boolean(base?.querySelector('[data-action="clear-selection"]')),
    filter: filter ? filter.getAttribute('placeholder') : null,
    truncated: base?.querySelector('[data-testid="checklist-truncated"]')?.textContent ?? null,
    error: error ? { kind: error.dataset.kind, lines: [...error.querySelectorAll('p')].map((p) => p.textContent) }
      : null,
    rows, add: add ? { text: add.textContent, disabled: add.disabled } : null,
    notListed: base?.querySelector('[data-testid="not-listed"]')?.textContent ?? null,
    detected: base?.querySelector('[data-testid="detected-server"]')?.textContent ?? null,
    empty: [...(box?.querySelectorAll('p') ?? [])]
      .some((p) => p.textContent === 'The server didn’t list any models.') };
}, scope);

/** @brief 一行的比较形式（expectRows 的字段）。 */
const shapeOf = (row) => ({ id: row.id, chat: row.chat, picked: row.picked, pickDisabled: row.pickDisabled,
  locked: row.locked, window: row.window, max: row.max, reasoning: row.reasoning, image: row.image,
  defaults: row.defaults, pi: row.pi, tags: row.tags, hints: row.hints });

/** @brief Add provider：填 Base URL（和 API key），Fetch models，等清单或列表错误出来；返回表单的选择器。 */
async function fetchNew(page, baseUrl, key = '') {
  await page.locator('[data-action="add-provider"]').click();
  const form = page.getByTestId('provider-form');
  await form.waitFor({ timeout: 10000 });
  await form.getByLabel('Base URL', { exact: true }).fill(baseUrl);
  if (key) await form.getByLabel('API key', { exact: true }).fill(key);
  await form.locator('[data-action="fetch-models"]').click();
  await form.locator('[data-testid="checklist"], [data-testid="list-error"]').first().waitFor({ timeout: 15000 });
  return '[data-testid="provider-form"]';
}

/** @brief 清单里某一行（scope 为表单或卡的选择器）。 */
const rowAt = (page, scope, id) => page.locator(`${scope} [data-testid="discovered-row"][data-model="${id}"]`);

/** @brief 点 Add，等回放桥收到写命令、表单（或卡上的清单）关闭；返回这次的写命令。 */
async function clickAdd(page, scope, closed) {
  const before = (await writes(page)).length;
  await page.locator(`${scope} [data-action="add-models"]`).click();
  await page.waitForFunction((n) => window.__replay.status.modelWrites.length > n, before, { timeout: 10000 })
    .catch(() => {});
  await page.locator(closed).waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  const command = (await writes(page))[before] ?? null;
  return { command, closed: await page.locator(closed).count() === 0 };
}

/** @brief 等 Add provider 表单关闭后设置页按新读到的 models.get 显示 want 这些卡。 */
async function untilCards(page, want) {
  await page.waitForFunction((ids) => [...document.querySelectorAll('[data-testid="provider-card"]')]
    .map((el) => el.dataset.provider).join() === ids.join(), want, { timeout: 10000 }).catch(() => {});
  return cards(page);
}

// ---------- md-openrouter（MD-07） ----------

/** @brief 过滤用的两个前缀：id 里 "/" 前面最常见的两段（各有一行以上、又不是全部）。 */
function prefixes(ids) {
  const counts = new Map();
  for (const id of ids) counts.set(id.split('/')[0], (counts.get(id.split('/')[0]) ?? 0) + 1);
  return [...counts].filter(([, n]) => n > 1 && n < ids.length).sort((a, b) => b[1] - a[1]).slice(0, 2)
    .map(([prefix]) => `${prefix}/`);
}

/** @brief 显示着的行：id 含过滤框的文字（不分大小写）。 */
const shownBy = (ids, needle) => ids.filter((id) => id.toLowerCase().includes(needle.toLowerCase()));

/** @brief 拉取后的清单：标题、行与列表顺序、默认勾选、Default、标记与提示、过滤框、Add models 不可用。 */
async function openrouterList(page, scope, result) {
  const s = await checklistOf(page, scope);
  const want = expectRows(result.models);
  const got = s.rows.map(shapeOf);
  const bad = got.map((row, i) => (same(row, want[i]) ? null : { got: row, want: want[i] })).filter(Boolean);
  const unreported = want.filter((row) => row.defaults.length).length;
  const hinted = want.filter((row) => row.hints.length).length;
  record(`MD-07 replay md-openrouter: the real list shows "Models (${result.models.length})" and one row per `
    + `recorded model in list order with its values; the default picks follow the reported type (none reported: `
    + `${want.filter((r) => r.picked).length} ticked); "Default" on the ${unreported} rows whose value the `
    + `server didn't report and still is the default; "${HINT_TEXT.no_tools}" on the ${hinted} rows with the hint; `
    + `each row's box reads `
    + '"Add <id>"',
  s.title === `Models (${result.models.length})` && got.length === want.length && bad.length === 0
    && s.rows.every((row) => row.label === `Add ${row.id}`) && unreported > 0 && hinted > 0,
  brief({ title: s.title, rows: got.length, bad: bad.slice(0, 3) }));
  const truncated = result.truncated ? 'Showing the first 1,000 models.' : null;
  record(`MD-07 replay md-openrouter: more than 20 rows: the filter box ("Filter models"), Select all and Clear `
    + `selection are shown; with nothing ticked the button reads "${addLabel(0)}" and is unavailable; the recorded `
    + `list is ${result.truncated ? '' : 'not '}truncated, so "Showing the first 1,000 models." is `
    + `${result.truncated ? 'shown' : 'absent'}`,
  s.filter === 'Filter models' && s.selectAll && s.clear && s.add?.text === addLabel(0) && s.add.disabled
    && s.truncated === truncated, brief({ filter: s.filter, add: s.add, truncated: s.truncated }));
  return s;
}

/** @brief 填过滤框，返回这时显示的行 id 与 Add 按钮。 */
async function filterTo(page, scope, text) {
  await page.locator(`${scope} [data-testid="checklist-filter"]`).fill(text);
  const s = await checklistOf(page, scope);
  return { ids: s.rows.map((row) => row.id), picked: s.rows.filter((row) => row.picked).map((row) => row.id),
    add: s.add };
}

/** @brief 过滤（不分大小写）、Select all 与 Clear selection 只作用于显示着的行、Add 的文字随勾选数变。 */
async function openrouterFilter(page, scope, ids) {
  const [first, second] = prefixes(ids);
  const a = shownBy(ids, first);
  const b = shownBy(ids, second);
  const upper = await filterTo(page, scope, first.toUpperCase());
  record(`MD-07 replay md-openrouter: typing "${first.toUpperCase()}" in the filter shows only the ${a.length} rows `
    + 'whose ID contains it, ignoring case, in list order', same(upper.ids, a) && a.length < ids.length,
  brief({ got: upper.ids.length, want: a.length }));
  await page.locator(`${scope} [data-action="select-all"]`).click();
  const ticked = await filterTo(page, scope, first);
  record(`MD-07 replay md-openrouter: Select all ticks the ${a.length} shown rows; the button reads `
    + `"${addLabel(a.length)}"`, same(ticked.picked, a) && ticked.add?.text === addLabel(a.length),
  brief({ picked: ticked.picked.length, add: ticked.add }));
  await filterTo(page, scope, second);
  await page.locator(`${scope} [data-action="select-all"]`).click();
  const both = await filterTo(page, scope, second);
  await page.locator(`${scope} [data-action="clear-selection"]`).click();
  const cleared = await filterTo(page, scope, second);
  const all = await filterTo(page, scope, '');
  record(`MD-07 replay md-openrouter: with "${second}" shown, Select all adds its ${b.length} rows `
    + `("${addLabel(a.length + b.length)}"); Clear selection then clears only those, the hidden "${first}" rows stay `
    + `ticked ("${addLabel(a.length)}")`, same(both.picked, b) && both.add?.text === addLabel(a.length + b.length)
    && cleared.picked.length === 0 && cleared.add?.text === addLabel(a.length) && same(all.picked, a),
  brief({ both: both.add, cleared: cleared.add, picked: all.picked.length }));
  return a;
}

/** @brief Default 改了值就不标；勾上这一行，过滤框藏起其余勾选的行后 Add，命令里有全部勾选的行。 */
async function openrouterAdd(page, scope, result, picked) {
  // Max output 是默认值（写 Default）的行：服务没报告、也不是取自 pi 的（2026-10-26）
  const target = result.models.find((m) => !m.reported.maxTokens && !piOf(m).includes('maxTokens')
    && !picked.includes(m.id));
  if (!target) {
    record('MD-07 replay md-openrouter: the recording has a row whose Max output the server didn\'t report outside the '
      + 'ticked rows (to check "Default" after a change)', false, brief({ picked: picked.length }));
    return;
  }
  const first = Math.min(1000, target.contextWindow - 1);
  // 改成的值不能恰好是默认值（窗口很小时默认值也可能是 1000）
  const value = first === unreportedMax(target.contextWindow) ? first - 1 : first;
  await filterTo(page, scope, target.id.toUpperCase());
  const row = rowAt(page, scope, target.id);
  await row.locator('input[data-field="maxTokens"]').fill(String(value));
  await row.locator('input[name="pick"]').check();
  const s = await checklistOf(page, scope);
  const edited = s.rows.find((r) => r.id === target.id);
  record(`MD-07 replay md-openrouter: "Default" next to the Max output of ${target.id} goes away after changing it `
    + `to ${value} (no longer the default); ticking it makes "${addLabel(picked.length + 1)}" while the other ticked `
    + 'rows are hidden', edited?.max === String(value) && !edited.defaults.includes('maxTokens') && edited.picked
    && s.add?.text === addLabel(picked.length + 1) && s.rows.length < result.models.length,
  brief({ edited, add: s.add }));
  const { command, closed } = await clickAdd(page, scope, scope);
  const typed = pairs(readFixture('md-openrouter').steps, 'models.discover')[0].command.target.baseUrl;
  const models = result.models.filter((m) => picked.includes(m.id) || m.id === target.id)
    .map((m) => modelOf(m, m.id === target.id ? { maxTokens: value } : {}));
  const provider = { name: result.name, baseUrl: typed, api: result.api, concurrency: 4, compat: {} };
  record(`MD-07 replay md-openrouter: Add sends models.saveProvider with all ${models.length} ticked rows in list `
    + 'order (also those hidden by the filter, the changed Max output included) and the prefilled provider; the form '
    + 'closes', closed && command?.type === 'models.saveProvider' && command.id === null
    && canonical(command.models) === canonical(models) && canonical(command.provider) === canonical(provider)
    && command.keySecret === undefined, brief({ closed, provider: command?.provider, count: command?.models?.length }));
}

/** @brief md-openrouter：几百行的真实清单。 */
async function openrouterCheck(page) {
  const fx = readFixture('md-openrouter');
  const { command, value: result } = pairs(fx.steps, 'models.discover')[0];
  await load(page, fx.name);
  const scope = await fetchNew(page, command.target.baseUrl);
  await openrouterList(page, scope, result);
  const picked = await openrouterFilter(page, scope, result.models.map((m) => m.id));
  await shot(page, 'md-openrouter-filter');
  await openrouterAdd(page, scope, result, picked);
}

// ---------- md-glm（MD-07、MD-15） ----------

/** @brief md-glm：真实的列表错误。 */
async function glmCheck(page) {
  const fx = readFixture('md-glm');
  const { command, value: result } = pairs(fx.steps, 'models.discover')[0];
  await load(page, fx.name);
  const before = await page.evaluate(() => window.__replay.status.queries.length);
  const scope = await fetchNew(page, command.target.baseUrl, SYNTHETIC_KEY);
  const s = await checklistOf(page, scope);
  const sent = (await page.evaluate(() => window.__replay.status.queries)).slice(before)
    .filter((q) => q.type === 'models.discover');
  const { kind, detail } = result.listError;
  const line = LIST_ERROR[kind](detail, new URL(result.baseUrl).host);
  await shot(page, 'md-glm');
  record(`MD-07 replay md-glm: the real list error (${kind}) takes the checklist's place: "${oneLine(line, 80)}" and `
    + `"${STILL}"; no "Models (N)" title, Select all, Clear selection or filter box; the button reads "${addLabel(0)}" `
    + 'and is unavailable', s.error?.kind === kind && same(s.error.lines, [line, STILL]) && s.title === null
    && !s.selectAll && !s.clear && s.filter === null && s.rows.length === 0 && s.add?.text === addLabel(0)
    && s.add.disabled, brief(s));
  record('MD-15 replay harness: models.discover is answered from the fixture by address; the API key typed in the '
    + 'form (synthetic) goes out with the command and does not change which recorded result answers it',
  sent.length === 1 && sent[0].target.keySecret === SYNTHETIC_KEY && sent[0].target.baseUrl === command.target.baseUrl
    && s.error?.kind === kind,
  brief({ sent: sent.map((q) => ({ ...q.target, keySecret: Boolean(q.target.keySecret) })) }));
}

// ---------- md-deepseek（MD-07、MD-13、MD-15） ----------

/** @brief 改一行的数字框，返回这一行此刻的样子与 Add 按钮。 */
async function editSize(page, scope, id, field, value) {
  await rowAt(page, scope, id).locator(`input[data-field="${field}"]`).fill(String(value));
  const s = await checklistOf(page, scope);
  return { row: s.rows.find((r) => r.id === id), add: s.add };
}

/** @brief DeepSeek 式清单：类型不明、多行时都不勾；Select all。 */
async function richList(page, scope, result) {
  const s = await checklistOf(page, scope);
  const want = expectRows(result.models);
  record(`MD-07 replay md-deepseek: the DeepSeek-style list shows "Models (${result.models.length})" with the recorded `
    + 'values; the server reports no model type and several rows can be added, so none is ticked; no "Default" '
    + `(every value reported); "${addLabel(0)}" is unavailable; with ${result.models.length} rows (not more than 20) `
    + 'there is no filter box', s.title === `Models (${result.models.length})`
    && same(s.rows.map(shapeOf), want) && want.every((row) => !row.picked && row.defaults.length === 0)
    && s.add?.text === addLabel(0) && s.add.disabled && result.models.length <= 20 && s.filter === null
    && s.selectAll && s.clear, brief({ got: s.rows.map(shapeOf), want, filter: s.filter }));
  await page.locator(`${scope} [data-action="select-all"]`).click();
  const all = await checklistOf(page, scope);
  record(`MD-07 replay md-deepseek: Select all ticks every row: "${addLabel(result.models.length)}"`,
    all.rows.every((row) => row.picked) && all.add?.text === addLabel(result.models.length), brief(all.add));
}

/**
 * @brief 字段错误时 Add 不可用：窗口为 0；Max output 不小于窗口。只有勾选的行的错误挡住 Add（models-settings.md
 *        "勾选的行有错误"）：取消勾选有错误的那一行后 Add 可用，再勾上。
 */
async function richErrors(page, scope, result) {
  const [vision, long] = result.models;
  const zero = await editSize(page, scope, long.id, 'contextWindow', 0);
  record(`MD-07 replay md-deepseek: a Context window of 0 on a ticked row shows "${WINDOW_ERROR}" and the Add button `
    + 'is unavailable', zero.row.errors.some((e) => e.field === 'contextWindow' && e.text === WINDOW_ERROR)
    && zero.add?.disabled === true, brief(zero));
  const pick = rowAt(page, scope, long.id).locator('input[name="pick"]');
  await pick.uncheck();
  const off = await checklistOf(page, scope);
  const offRow = off.rows.find((r) => r.id === long.id);
  const rest = result.models.length - 1;
  record(`MD-07 replay md-deepseek: unticking the row with the error keeps the error but makes "${addLabel(rest)}" `
    + 'available again (only ticked rows with errors block Add)', offRow?.picked === false
    && offRow.errors.some((e) => e.field === 'contextWindow' && e.text === WINDOW_ERROR)
    && off.add?.text === addLabel(rest) && off.add.disabled === false, brief({ row: offRow, add: off.add }));
  await pick.check();
  await editSize(page, scope, long.id, 'contextWindow', long.contextWindow);
  const big = await editSize(page, scope, vision.id, 'maxTokens', vision.contextWindow);
  record(`MD-07 replay md-deepseek: Max output equal to the Context window shows "${MAX_ERROR}" and the Add button is `
    + 'unavailable', big.row.errors.some((e) => e.field === 'maxTokens' && e.text === MAX_ERROR)
    && big.add?.disabled === true, brief(big));
}

/**
 * @brief 照录制改清单（窗口、Max output、两个勾选框）；改小了窗口的那一行先改到报告的输出上限以下再改到录制的值，
 *        检查 Max output 随窗口按 §4.3 变；其余的行先改窗口，Max output 与录制的不同时再改（改过的不再随窗口变）。
 * @param recorded 录制里 models.saveProvider 的 models
 */
async function richEdits(page, scope, result, recorded) {
  const wantOf = (m) => recorded.find((r) => r.id === m.id);
  const long = result.models.find((m) => wantOf(m).contextWindow < m.contextWindow);
  const low = Math.floor(long.maxTokens / 2);
  const under = await editSize(page, scope, long.id, 'contextWindow', low);
  const wanted = recorded.find((r) => r.id === long.id).contextWindow;
  const over = await editSize(page, scope, long.id, 'contextWindow', wanted);
  record(`MD-07 replay md-deepseek: lowering the Context window of ${long.id} to ${low} (below the reported max output `
    + `${long.maxTokens}) makes Max output ${unreportedMax(low)} with "Default"; setting it to ${wanted} brings `
    + `back the reported ${long.maxTokens} without "Default"`, under.row.max === String(unreportedMax(low))
    && under.row.defaults.includes('maxTokens') && over.row.max === String(long.maxTokens)
    && !over.row.defaults.includes('maxTokens') && over.row.window === String(wanted), brief({ under, over }));
  for (const m of result.models.filter((item) => item.id !== long.id)) {
    const want = wantOf(m);
    const row = rowAt(page, scope, m.id);
    if (want.contextWindow !== m.contextWindow) {
      await row.locator('input[data-field="contextWindow"]').fill(String(want.contextWindow));
    }
    const max = row.locator('input[data-field="maxTokens"]');
    if (await max.inputValue() !== String(want.maxTokens)) await max.fill(String(want.maxTokens));
    await row.locator('input[data-field="reasoning"]').setChecked(want.reasoning);
    await row.locator('input[data-field="image"]').setChecked(want.input.includes('image'));
  }
  const longRow = rowAt(page, scope, long.id);
  await longRow.locator('input[data-field="reasoning"]').setChecked(wantOf(long).reasoning);
  await longRow.locator('input[data-field="image"]').setChecked(wantOf(long).input.includes('image'));
}

/** @brief 第一个提供商：DeepSeek 式清单的检查与改动，Add 3 models 发出录制里的命令。 */
async function richFlow(page, fx) {
  const [rich] = pairs(fx.steps, 'models.discover');
  const [saved] = writesOf(fx);
  const scope = await fetchNew(page, rich.command.target.baseUrl);
  await richList(page, scope, rich.value);
  await richErrors(page, scope, rich.value);
  await richEdits(page, scope, rich.value, saved.models);
  await shot(page, 'md-deepseek-rich');
  const { command, closed } = await clickAdd(page, scope, scope);
  record(`MD-07 replay md-deepseek: "${addLabel(saved.models.length)}" sends models.saveProvider with the ticked rows `
    + 'in checklist order and the changed values, the same command the real App got when recorded; the form closes',
  closed && canonical(command) === canonical(saved), brief({ command, saved }));
}

/** @brief 第二个提供商：typed 清单的默认勾选与 Not a chat model、Default 只在值仍是默认值时，Add 1 model。 */
async function typedFlow(page, fx) {
  const typed = pairs(fx.steps, 'models.discover')[1];
  const saved = writesOf(fx)[1];
  const scope = await fetchNew(page, typed.command.target.baseUrl);
  const s = await checklistOf(page, scope);
  const want = expectRows(typed.value.models);
  const picked = want.filter((row) => row.picked).length;
  record('MD-07 replay md-deepseek typed list: the row the server reports as a chat model is ticked, the embedding row '
    + '(chat false) is not and reads "Not a chat model"; both values of every row read "Default" (not reported '
    + `by the server, Mori's defaults); the button reads "${addLabel(picked)}"`, same(s.rows.map(shapeOf), want)
    && want.some((r) => r.chat === 'true' && r.picked) && want.some((r) => r.chat === 'false' && !r.picked)
    && want.every((r) => r.defaults.length === 2) && s.add?.text === addLabel(picked),
  brief({ got: s.rows.map(shapeOf), want, add: s.add }));
  const first = typed.value.models[0];
  // 窗口改成没报告的输出上限：Max output 随之变为它的一半（§4.3），看得出变了
  const low = first.maxTokens;
  const changed = await editSize(page, scope, first.id, 'contextWindow', low);
  const back = await editSize(page, scope, first.id, 'contextWindow', first.contextWindow);
  record(`MD-07 replay md-deepseek typed list: "Default" next to the Context window of ${first.id} goes away after `
    + `changing the value to ${low} and comes back with the default; the unreported Max output follows the window `
    + `(${unreportedMax(low)}, then ${first.maxTokens}) and, being the default each time, keeps "Default"`,
  !changed.row.defaults.includes('contextWindow') && changed.row.window === String(low)
    && changed.row.max === String(unreportedMax(low)) && changed.row.defaults.includes('maxTokens')
    && back.row.defaults.includes('contextWindow') && back.row.defaults.includes('maxTokens')
    && back.row.max === String(first.maxTokens) && unreportedMax(low) !== first.maxTokens, brief({ changed, back }));
  const { command, closed } = await clickAdd(page, scope, scope);
  record(`MD-07 replay md-deepseek typed list: "${addLabel(picked)}" sends the recorded models.saveProvider (only the `
    + 'default-ticked row); the form closes', closed && canonical(command) === canonical(saved),
  brief({ command, saved }));
}

/**
 * @brief 设置页此刻的模型行：说明、(default)、(from pi) 与它的悬停（2026-10-26）、提示（种类、文字、Use）。
 *        (from pi) 的文字不是" (from pi)"时记成"<field>=<文字>"，与期望的比较时不相等。
 */
const modelRowsOf = (page) => page.locator('[data-testid="model-row"]').evaluateAll((rows) => rows.map((row) => ({
  ref: row.dataset.model, meta: row.querySelector('.model-meta')?.textContent ?? '',
  defaults: [...row.querySelectorAll('[data-testid="default-value"]')].map((el) => el.dataset.field),
  pi: [...row.querySelectorAll('[data-testid="pi-value"]')].map((el) => (el.textContent === '(from pi)'
    ? el.dataset.field : `${el.dataset.field}=${el.textContent}`)),
  piTitles: [...row.querySelectorAll('[data-testid="pi-value"]')].map((el) => el.title),
  hints: [...row.querySelectorAll('[data-testid="model-hint"]')].map((el) => ({ kind: el.dataset.kind,
    text: el.querySelector('.muted')?.textContent ?? '', use: el.querySelector('[data-action="use-reported"]')
      ?.textContent ?? null })) })));

/** @brief 设置页某个 models.get 结果里每个模型该显示的：ref、说明开头、(default)、(from pi)、提示。 */
function expectModelRows(info) {
  return info.config.providers.flatMap((provider) => provider.models.map((model) => {
    const ref = `${provider.id}/${model.id}`;
    const profile = info.profiles[ref];
    return { ref, provider: provider.id, model, meta: metaStart(model, profile),
      defaults: rowDefaults(model, profile), pi: rowPi(model, profile), catalog: profile?.catalog ?? null,
      hints: expectHints(provider.api, model, profile) };
  }));
}

/** @brief 模型行与录下的档案一致的前一半：行的顺序、说明开头、(default) 与 (from pi)。 */
const metaMatch = (got, want) => got.length === want.length && want.every((w, i) => got[i].ref === w.ref
  && got[i].meta.startsWith(w.meta) && same(got[i].defaults, w.defaults) && same(got[i].pi, w.pi));
/** @brief 后一半：行的顺序、提示的种类与文字、每条都有 Use。 */
const hintsMatch = (got, want) => got.length === want.length && want.every((w, i) => got[i].ref === w.ref
  && same(got[i].hints, w.hints.map((h) => ({ kind: h.kind, text: h.text, use: 'Use' }))));
/** @brief 模型行与录下的档案一致：说明开头与 (default)、提示的种类与文字、每条都有 Use。 */
const rowsMatch = (got, want) => metaMatch(got, want) && hintsMatch(got, want);

/** @brief 旧档案（reported 为 null）的模型行：没有 (default)，提示只有 §8 表的第四种。 */
function oldProfileCheck(got, info, label) {
  const old = expectModelRows(info).filter((w) => info.profiles[w.ref] && info.profiles[w.ref].reported === null);
  const rows = old.map((w) => got.find((g) => g.ref === w.ref));
  record(`MD-13 replay md-deepseek ${label}: a profile written before model discovery (no reported values) shows no `
    + '"(default)" and of the §8 hints only "This model returned thinking content." with Use',
  old.length > 0 && rows.every((g) => g && g.defaults.length === 0 && same(g.hints.map((h) => h.kind),
    ['thinking-seen']) && g.hints[0].text === 'This model returned thinking content.' && g.hints[0].use === 'Use'),
  brief({ old: old.map((w) => w.ref), rows }));
}

/** @brief 加入后的设置页：(default)、五种提示、旧档案。 */
async function settingsRows(page, info) {
  const want = expectModelRows(info);
  const got = await modelRowsOf(page);
  await shot(page, 'md-deepseek-settings');
  const kinds = new Set(want.flatMap((w) => w.hints.map((h) => h.kind)));
  record('MD-13 replay md-deepseek: model rows write "(default)" after the configured Context window and Max '
    + 'output exactly where the recorded profile has no reported value and the configured value is still Mori\'s '
    + 'default (the typed model: both), and nowhere else', rowsMatch(got, want)
    && want.some((w) => w.defaults.length === 2), brief({ got, want: want.map((w) => ({
    ref: w.ref, meta: w.meta, defaults: w.defaults })) }));
  const lowers = want.some((w) => w.hints.some((h) => h.kind === 'context' && h.model.maxTokens < w.model.maxTokens));
  record('MD-13 replay md-deepseek: each model row shows the §8 hints its recorded profile and config call for, in the '
    + `table's order, each with Use, and no others; the recording covers all five (${HINT_KINDS.join(', ')}), one `
    + 'context hint also lowering Max output', rowsMatch(got, want) && HINT_KINDS.every((kind) => kinds.has(kind))
    && lowers,
  brief({ got: got.map((g) => ({ ref: g.ref, hints: g.hints })), kinds: [...kinds] }));
  oldProfileCheck(got, info, 'after the adds');
  return want;
}

/**
 * @brief 点每条提示的 Use：models.saveModel 带按 §8 表改过的模型，不带 thinkingLevel。回放桥应答后重新读到的是同一个
 *        录下的 models.get，提示仍在；等这一行保存完（Use 重新可用）再点下一条。
 */
async function useHints(page, want) {
  for (const w of want) {
    for (const hint of w.hints) {
      const before = (await writes(page)).length;
      const selector = `[data-testid="model-row"][data-model="${w.ref}"] [data-testid="model-hint"]`
        + `[data-kind="${hint.kind}"] [data-action="use-reported"]`;
      await page.locator(selector).click();
      await page.waitForFunction((n) => window.__replay.status.modelWrites.length > n, before, { timeout: 10000 })
        .catch(() => {});
      await page.waitForFunction((sel) => document.querySelector(sel)?.disabled === false, selector, { timeout: 10000 })
        .catch(() => {});
      const command = (await writes(page))[before];
      const expected = { type: 'models.saveModel', providerId: w.provider, model: hint.model };
      record(`MD-13 replay md-deepseek: Use on "${hint.text}" (${w.ref}) saves at once: models.saveModel with `
        + `${brief(changeOf(w.model, hint.model), 120)} and no thinkingLevel`,
      canonical(command) === canonical(expected), brief({ command, expected }));
    }
  }
}

/** @brief Use 改了模型的哪些字段（检查名里写）。 */
function changeOf(model, changed) {
  return Object.fromEntries(Object.keys(changed).filter((key) => !same(model[key], changed[key]))
    .map((key) => [key, changed[key]]));
}

/** @brief 卡上的清单此刻的 Add 按钮与勾上的行。 */
async function cardPicks(page, scope) {
  const s = await checklistOf(page, scope);
  return { add: s.add, picked: s.rows.filter((row) => row.picked).map((row) => row.id) };
}

/**
 * @brief Legacy endpoint 卡上的 Fetch models：已加入的行标 Added、不能勾；能加入的只有一行时默认勾上（类型不明）；
 *        Clear selection、Select all 只作用于能勾的行；Add 发 models.addModels。
 */
async function cardFlow(page, fx) {
  const card = pairs(fx.steps, 'models.discover').find((p) => p.command.target.kind === 'provider');
  const providerId = card.command.target.providerId;
  const scope = `[data-testid="provider-card"][data-provider="${providerId}"]`;
  await page.locator(`${scope} [data-action="fetch-models"]`).first().click();
  await page.locator(`${scope} [data-testid="checklist"]`).waitFor({ timeout: 15000 });
  const s = await checklistOf(page, scope);
  const want = expectRows(card.value.models);
  const usable = want.filter((row) => !row.pickDisabled).map((row) => row.id);
  record(`MD-07 replay md-deepseek card: Fetch models on the ${providerId} card opens the checklist in the card: the `
    + 'model already in the provider reads "Added" and cannot be ticked or changed; the server reports no type and '
    + `only one row can be added, so it is ticked ("${addLabel(1)}")`, same(s.rows.map(shapeOf), want)
    && usable.length === 1 && want.some((row) => row.pickDisabled && row.locked
      && row.tags.some((tag) => tag.kind === 'added'))
    && same(s.rows.filter((row) => row.picked).map((row) => row.id), usable) && s.add?.text === addLabel(1),
  brief({ got: s.rows.map(shapeOf), want, add: s.add }));
  await page.locator(`${scope} [data-action="clear-selection"]`).click();
  const cleared = await cardPicks(page, scope);
  await page.locator(`${scope} [data-action="select-all"]`).click();
  const all = await cardPicks(page, scope);
  record(`MD-07 replay md-deepseek card: Clear selection leaves nothing ticked ("${addLabel(0)}", unavailable); `
    + `Select all ticks only the rows that can be added, not the Added one ("${addLabel(usable.length)}")`,
  cleared.picked.length === 0 && cleared.add?.text === addLabel(0) && cleared.add.disabled && same(all.picked, usable)
    && all.add?.text === addLabel(usable.length), brief({ cleared, all }));
  const { command, closed } = await clickAdd(page, scope, `${scope} [data-testid="checklist"]`);
  const models = card.value.models.filter((m) => usable.includes(m.id)).map((m) => modelOf(m));
  const expected = { type: 'models.addModels', providerId, models };
  record(`MD-07 replay md-deepseek card: "${addLabel(usable.length)}" sends models.addModels with the ticked rows in `
    + 'list order', canonical(command) === canonical(expected), brief({ command, expected }));
  record('MD-15 replay harness: models.addModels is answered like the other model writes (no error): the card\'s '
    + 'checklist closes', closed, brief({ closed }));
}

/** @brief md-deepseek：两次 Add provider、加入后的设置页、Use、卡上的 Fetch models。 */
async function deepseekCheck(page) {
  const fx = readFixture('md-deepseek');
  const ids = (info) => info.config.providers.map((p) => p.id);
  await load(page, fx.name);
  const initial = stateAfter(fx, 0);
  const start = await untilCards(page, ids(initial));
  oldProfileCheck(await modelRowsOf(page), initial, 'before the adds');
  await richFlow(page, fx);
  const one = await untilCards(page, ids(stateAfter(fx, 1)));
  await typedFlow(page, fx);
  const final = stateAfter(fx, 2);
  const two = await untilCards(page, ids(final));
  record('MD-15 replay harness: Settings first shows the recorded models.get (only the providers of the setup), and '
    + 'after each Add the state the recording read after the same number of writes',
  same(start, ids(initial)) && same(one, ids(stateAfter(fx, 1))) && same(two, ids(final))
    && ids(final).length === ids(initial).length + 2, brief({ start, one, two }));
  const want = await settingsRows(page, final);
  await useHints(page, want);
  await cardFlow(page, fx);
}

// ---------- md-*-card：卡上拉取的真实录制（MD-07、MD-13、MD-15；md-real.mjs 写下） ----------

/** 卡上拉取的真实录制的文件名（md-real.mjs 写下 md-deepseek-card.json、md-glm-card.json） */
const CARD_FILE = /^md-.+-card\.json$/;

/** @brief CSS 属性选择器里的值（转义引号与反斜杠）。 */
const attr = (value) => String(value).replace(/["\\]/g, '\\$&');
/** @brief 地址的主机，非默认端口时带端口（§6.3 unreachable 的"<主机>"）；不是 URL 时原样。 */
const hostOf = (url) => (URL.canParse(url) ? new URL(url).host : url);

/**
 * @brief 一份卡上录制里回放要用的：卡上的 models.discover（kind provider）的提供商与结果；卡上拉取之前的 models.get
 *        （录制里第一条写命令之前的最后一个）与其中的这个提供商；界面发的 models.addModels（录制里第一条写命令是这个
 *        提供商的 models.addModels 时是它，没有写命令时为 null）。之后的写命令是模型行提示的 Use（cardUses 照着点，
 *        2026-10-26 起 md-glm-pi-card 有）。
 * @return { providerId, provider, result, initial, add, problems（录制不能这样回放的地方） }
 */
function cardRecording(fx) {
  const fetched = pairs(fx.steps, 'models.discover').find((p) => p.command?.target?.kind === 'provider') ?? null;
  const initial = stateAfter(fx, 0);
  const providerId = fetched?.command.target.providerId ?? null;
  const provider = initial?.config.providers.find((p) => p.id === providerId) ?? null;
  const [first] = writesOf(fx);
  const add = first?.type === 'models.addModels' && first.providerId === providerId ? first : null;
  const unlisted = add ? add.models.filter((m) => !fetched.value.models.some((r) => r.id === m.id)) : [];
  // 命令本身失败或被取消的结果没有清单也没有列表错误（§5.2），界面不会显示这里检查的东西
  const failed = fetched && (fetched.value.error !== null || fetched.value.cancelled);
  const problems = [...(fetched ? [] : ['no models.discover for a provider card']),
    ...(failed ? [`the recorded models.discover has error ${fetched.value.error}, cancelled `
      + `${fetched.value.cancelled}`] : []),
    ...(initial ? [] : ['no models.get before the first model write']),
    ...(fetched && initial && !provider ? [`${providerId} is not in the models.get before the fetch`] : []),
    ...(first && !add ? [`the first model write is ${first.type}, not the card's models.addModels`] : []),
    ...unlisted.map((m) => `the recorded models.addModels adds ${m.id}, which is not in the recorded list`)];
  return { providerId, provider, result: fetched?.value ?? null, initial, add, problems };
}

/**
 * @brief 设置页此刻的模型行与录下的 models.get 一致（MD-13）：(default) 只在档案没有报告值、值仍是默认值的地方；§8 的提示照档案
 *        与配置，按表的顺序，每条有 Use。
 * @param label 检查名里的说明
 */
function cardModelRows(got, info, label) {
  const want = expectModelRows(info);
  const marks = want.reduce((n, w) => n + w.defaults.length, 0);
  const count = want.reduce((n, w) => n + w.hints.length, 0);
  const kinds = [...new Set(want.flatMap((w) => w.hints.map((h) => h.kind)))];
  record(`MD-13 replay ${label}: each of the ${want.length} model rows writes "(default)" after the configured `
    + `Context window and Max output exactly where its recorded profile has no reported value and the value is still `
    + `the default (${marks} in all) and nowhere else`, metaMatch(got, want), brief({
    got: got.map((g) => ({ ref: g.ref, meta: g.meta, defaults: g.defaults })),
    want: want.map((w) => ({ ref: w.ref, meta: w.meta, defaults: w.defaults })) }));
  record(`MD-13 replay ${label}: each model row shows the §8 hints its recorded profile and config call for, in the `
    + `table's order, each with Use, and no others (${count} in all${kinds.length ? `: ${kinds.join(', ')}` : ''})`,
  hintsMatch(got, want), brief({ got: got.map((g) => ({ ref: g.ref, hints: g.hints })),
    want: want.map((w) => ({ ref: w.ref, hints: w.hints.map((h) => h.text) })) }));
}

/** @brief 卡上的清单（§6.2、§6.5）：行、默认勾选、Default、标记与提示、读屏名、Add 按钮；标题行、过滤框、截断说明。 */
function cardList(name, rec, s) {
  const { models, truncated } = rec.result;
  const want = expectRows(models);
  const got = s.rows.map(shapeOf);
  const bad = got.map((row, i) => (same(row, want[i]) ? null : { got: row, want: want[i] })).filter(Boolean);
  const picked = want.filter((row) => row.picked).length;
  const unreported = want.filter((row) => row.defaults.length).length;
  record(`MD-07 replay ${name}: Fetch models on the ${rec.providerId} card shows "Models (${models.length})" and one `
    + `row per recorded model in list order with its values; ${picked} ticked by default (by the recorded chat type; `
    + 'with no type, only when a single row can be added; never Added or unusable rows); "Default" on the '
    + `${unreported} rows whose values the server didn't report and still are the defaults; marks and hints as `
    + 'recorded; each box reads '
    + `"Add <id>"; the button reads "${addLabel(picked)}"`, s.title === `Models (${models.length})`
    && got.length === want.length && bad.length === 0 && s.rows.every((row) => row.label === `Add ${row.id}`)
    && s.add?.text === addLabel(picked) && s.add.disabled === (picked === 0),
  brief({ title: s.title, rows: got.length, bad: bad.slice(0, 3), add: s.add }));
  const filter = models.length > 20 ? 'Filter models' : null;
  const cut = truncated ? 'Showing the first 1,000 models.' : null;
  record(`MD-07 replay ${name}: with ${models.length} rows the filter box is ${filter ? 'shown' : 'absent'} (only `
    + `above 20 rows); "Showing the first 1,000 models." is ${cut ? 'shown' : 'absent'} as recorded; Select all and `
    + `Clear selection are shown; "The server didn’t list any models." is ${models.length ? 'absent' : 'shown'}; `
    + 'the card has no Detected line', s.filter === filter && s.truncated === cut && s.selectAll && s.clear
    && s.empty === (models.length === 0) && s.detected === null && s.error === null,
  brief({ filter: s.filter, truncated: s.truncated, selectAll: s.selectAll, clear: s.clear, empty: s.empty,
    detected: s.detected }));
}

/** @brief 已在提供商里的模型（§6.5）：拉取时的配置里有的 id 标 Added、不能勾也不能改；别的行不标。 */
function cardAdded(name, rec, s) {
  const configured = rec.provider.models.map((m) => m.id);
  const listed = s.rows.filter((row) => configured.includes(row.id)).map((row) => row.id);
  const wrong = s.rows.filter((row) => {
    const added = row.tags.some((tag) => tag.kind === 'added');
    return configured.includes(row.id) ? !(added && row.pickDisabled && row.locked) : added;
  }).map((row) => ({ id: row.id, tags: row.tags, pickDisabled: row.pickDisabled, locked: row.locked }));
  record(`MD-07 replay ${name}: the listed models already in ${rec.providerId} when it was fetched `
    + `(${listed.join(', ') || 'none'}) read "Added" and can't be ticked or changed; no other row reads "Added"`,
  s.rows.length === rec.result.models.length && wrong.length === 0, brief({ configured, wrong: wrong.slice(0, 5) }));
}

/**
 * @brief Not listed 一行（§6.5）：录下的 notListed 就是拉取时的配置里有、列表里没有的 id（没拿到列表时为空），
 *        这一行写的就是它；为空时没有这一行。
 */
function cardNotListed(name, rec, s) {
  const listed = new Set(rec.result.models.map((m) => m.id));
  const missing = rec.result.listError ? [] : rec.provider.models.map((m) => m.id).filter((id) => !listed.has(id));
  const recorded = rec.result.notListed;
  const text = recorded.length ? `Not listed by the server: ${recorded.join(', ')}` : null;
  const why = rec.result.listError ? 'no list' : `the server listed every model of ${rec.providerId}`;
  record(`MD-07 replay ${name}: ${missing.length ? `"Not listed by the server: …" names the ${missing.length} `
    + `model(s) of ${rec.providerId} the server didn't list (${missing.join(', ')})`
    : `no "Not listed by the server" line (${why})`}`, s.notListed === text
    && same([...recorded].sort(), [...missing].sort()), brief({ shown: s.notListed, recorded, missing }));
}

/** @brief 列表错误（§6.3）：清单的位置换成录下的那一句与"You can still add model IDs below."。 */
function cardListError(name, rec, s) {
  const { kind, detail } = rec.result.listError;
  const line = LIST_ERROR[kind](detail, hostOf(rec.result.baseUrl));
  record(`MD-07 replay ${name}: Fetch models on the ${rec.providerId} card shows the recorded list error (${kind}) in `
    + `the checklist's place: "${oneLine(line, 80)}" and "${STILL}"; no "Models (N)" title, Select all, Clear `
    + `selection, filter box or rows; the button reads "${addLabel(0)}" and is unavailable; no Detected line`,
  s.error?.kind === kind && same(s.error.lines, [line, STILL]) && s.title === null && !s.selectAll && !s.clear
    && s.filter === null && s.rows.length === 0 && s.add?.text === addLabel(0) && s.add.disabled
    && s.detected === null, brief(s));
}

/** 改窗口后 Max output 用了哪一个（检查名里写） */
const MAX_SOURCE_TEXT = { server: 'the reported value, no "Default"',
  pi: 'the value from pi\'s model list, with "From pi"', default: 'the unreported default, with "Default"' };

/**
 * @brief 改窗口后没改过的 Max output 该是多少（§4.3、§6.2，独立实现）：服务报告的输出上限小于新窗口时用它；否则取自
 *        pi 的输出上限小于新窗口时用它（2026-10-26）；否则为没报告时的默认值。
 * @param source 录下的结果里这一行
 * @return { max, from: 'server' | 'pi' | 'default' }
 */
function followMax(source, window) {
  if (source.reported.maxTokens && source.maxTokens < window) return { max: source.maxTokens, from: 'server' };
  if (piOf(source).includes('maxTokens') && source.maxTokens < window) return { max: source.maxTokens, from: 'pi' };
  return { max: unreportedMax(window), from: 'default' };
}

/** @brief 清单的这一行的 Max output 是 want 的值，Default 与 From pi 的标记与它的来源相符。 */
const maxFollows = (row, want) => row?.max === String(want.max)
  && row.defaults.includes('maxTokens') === (want.from === 'default')
  && row.pi.includes('maxTokens') === (want.from === 'pi');

/**
 * @brief 勾上录下的一个模型、照它改值。改了 Context window 时检查 Max output 按 §4.3 随之变：服务报告的输出上限小于
 *        新窗口时用它，否则取自 pi 的小于新窗口时用它（标 From pi），否则为没报告时的默认值并标 Default。
 * @param source 录下的结果里这一行
 * @param model 录下的 models.addModels 里这个模型
 */
async function cardEdit(page, { name, scope, source, model }) {
  const row = rowAt(page, scope, model.id);
  await row.locator('input[name="pick"]').check();
  if (model.contextWindow !== source.contextWindow) {
    const { row: after } = await editSize(page, scope, model.id, 'contextWindow', model.contextWindow);
    const want = followMax(source, model.contextWindow);
    record(`MD-07 replay ${name}: changing the Context window of ${model.id} from ${source.contextWindow} to `
      + `${model.contextWindow} makes Max output ${want.max} (§4.3: ${MAX_SOURCE_TEXT[want.from]})`,
    after?.window === String(model.contextWindow) && maxFollows(after, want), brief(after));
  }
  const max = row.locator('input[data-field="maxTokens"]');
  if (await max.inputValue() !== String(model.maxTokens)) await max.fill(String(model.maxTokens));
  await row.locator('input[data-field="reasoning"]').setChecked(model.reasoning);
  await row.locator('input[data-field="image"]').setChecked(model.input.includes('image'));
}

/**
 * @brief 照录下的 models.addModels 加入（§6.5）：Clear selection，勾上录下的模型并照它改值，Add 发出与录下的相同的
 *        命令、卡上的清单关闭；之后设置页是录制里加入之后最后一个 models.get，模型行照它的档案（MD-13）。
 */
async function cardAdd(page, { name, scope, rec, fx }) {
  const { add, result } = rec;
  await page.locator(`${scope} [data-action="clear-selection"]`).click();
  for (const model of add.models) {
    await cardEdit(page, { name, scope, source: result.models.find((m) => m.id === model.id), model });
  }
  const ids = result.models.filter((m) => add.models.some((x) => x.id === m.id)).map((m) => m.id);
  const s = await checklistOf(page, scope);
  const picked = s.rows.filter((row) => row.picked).map((row) => row.id);
  await shot(page, `${name}-picked`);
  const { command, closed } = await clickAdd(page, scope, `${scope} [data-testid="checklist"]`);
  record(`MD-07 replay ${name}: after Clear selection, ticking the ${ids.length} recorded row(s) (${ids.join(', ')}) `
    + `with the recorded values makes "${addLabel(ids.length)}"; Add sends the recorded models.addModels and the `
    + 'card\'s checklist closes', same(picked, ids) && s.add?.text === addLabel(ids.length) && !s.add.disabled
    && closed && canonical(command) === canonical(add), brief({ picked, add: s.add, command, recorded: add }));
  const refs = add.models.map((m) => `${add.providerId}/${m.id}`);
  await page.waitForFunction((want) => want.every((ref) => document.querySelector(
    `[data-testid="model-row"][data-model="${CSS.escape(ref)}"]`)), refs, { timeout: 10000 }).catch(() => {});
  const rows = await modelRowsOf(page);
  cardModelRows(rows, stateAfter(fx, 1), `${name} after the add`);
  piModelRows(name, rows, stateAfter(fx, 1), refs);
}

/** @brief 一份卡上的真实录制：拉取之前的设置页、卡上的 Fetch models 与清单（或列表错误）、照录制加入、加入后的模型行。 */
async function cardCheck(page, name) {
  const fx = readFixture(name);
  const rec = cardRecording(fx);
  if (rec.problems.length) {
    record(`MD-07 replay ${name}: the recording (source ${fx.source}) can be replayed: a models.discover for a `
      + 'provider card that did not fail or get cancelled, the models.get before it with that provider, and no '
      + 'model write before the card\'s models.addModels of listed rows', false, brief(rec.problems));
    return;
  }
  await load(page, name);
  const want = rec.initial.config.providers.map((p) => p.id);
  const shown = await untilCards(page, want);
  record(`MD-15 replay harness: ${name}: Settings first shows the providers of the models.get recorded before the card `
    + `fetch (${want.join(', ')}; the card fetched is ${rec.providerId})`, same(shown, want), brief({ shown, want }));
  cardModelRows(await modelRowsOf(page), rec.initial, `${name} before the fetch`);
  const scope = `[data-testid="provider-card"][data-provider="${attr(rec.providerId)}"]`;
  await page.locator(`${scope} [data-action="fetch-models"]`).first().click();
  await page.locator(`${scope} [data-testid="checklist"], ${scope} [data-testid="list-error"]`).first()
    .waitFor({ timeout: 15000 });
  const s = await checklistOf(page, scope);
  await shot(page, `${name}-fetched`);
  if (rec.result.listError) {
    cardListError(name, rec, s);
    if (name === PI_CARD) {
      record(`MD-17 replay ${name}: the recording has a model list`, false, brief(rec.result.listError));
    }
  } else {
    cardList(name, rec, s);
    cardAdded(name, rec, s);
    const source = piChecklist(name, rec, s);
    if (source) await piEdit(page, { name, scope, source });
    if (name === PI_CARD) {
      await piThinkingToggle(page, { where: name, scope, models: rec.result.models });
      await manualPi(page, { where: name, scope, baseUrl: rec.provider.baseUrl,
        listed: rec.result.models.map((m) => m.id) });
    }
  }
  cardNotListed(name, rec, s);
  if (rec.add) await cardAdd(page, { name, scope, rec, fx });
  if (rec.add) await cardUses(page, { name, fx });
}

/** @brief 卡上的真实录制（有几份回放几份），按文件名排序；md-glm-pi-card 另覆盖 MD-17。 */
const cardFixtures = () => (existsSync(fixtureDir) ? readdirSync(fixtureDir) : [])
  .filter((file) => CARD_FILE.test(file)).sort().map((file) => file.replace(/\.json$/, ''))
  .map((name) => ({ name, ids: ['MD-07', 'MD-13', 'MD-15', ...(name === PI_CARD ? ['MD-17'] : [])],
    check: (page) => cardCheck(page, name) }));

// ---------- 取自 pi 的值（MD-17，2026-10-26，WP-15） ----------

/**
 * @brief 卡上清单里取自 pi 的项（§6.2）：录下的 catalog 里为真的项写 From pi（行的比较已在 MD-07 里），悬停写录下的
 *        catalog.provider；别的行不写。md-glm-pi-card 里至少要有一行取自 pi。
 * @return 能拿来改窗口的一行（取自 pi 的窗口、不是 Added 的）；没有时为 null
 */
function piChecklist(name, rec, s) {
  const rows = rec.result.models.filter((m) => piOf(m).length > 0);
  const bad = rows.map((m) => {
    const got = s.rows.find((row) => row.id === m.id);
    const ok = got && same(got.pi, piOf(m)) && got.piTitles.every((title) => title === piListTitle(m.catalog.provider));
    return ok ? null : { id: m.id, got: got ? { pi: got.pi, titles: got.piTitles } : null, want: piOf(m) };
  }).filter(Boolean);
  const stray = s.rows.filter((row) => row.pi.length && !rows.some((m) => m.id === row.id)).map((row) => row.id);
  const providers = [...new Set(rows.map((m) => m.catalog.provider))];
  const need = name === PI_CARD;
  record(`MD-17 replay ${name}: the ${rows.length} checklist rows whose values came from pi's model list (recorded `
    + `catalog${providers.length ? `: ${providers.join(', ')}` : ''}) read "${FROM_PI}" on exactly those values, the `
    + `hover reading "${piListTitle('<provider>')}"; no other row reads it`
    + `${need ? '; the recording has such rows' : ''}`,
  bad.length === 0 && stray.length === 0 && (!need || rows.length > 0),
  brief({ bad: bad.slice(0, 3), stray, rows: rows.map((m) => m.id) }));
  return rows.find((m) => !m.added && m.catalog.contextWindow) ?? null;
}

/**
 * @brief 改一行取自 pi 的窗口（§6.2）：改成这一行的 Max output 后 Context window 不再写 From pi，Max output 按 followMax
 *        变；改回录下的窗口又写 From pi、Max output 回到录下的值。改回之后这一行与拉取时相同，之后的 Add 照常。
 * @param source 录下的结果里这一行
 */
async function piEdit(page, { name, scope, source }) {
  const low = source.maxTokens;
  const changed = (await editSize(page, scope, source.id, 'contextWindow', low)).row;
  const back = (await editSize(page, scope, source.id, 'contextWindow', source.contextWindow)).row;
  const wantLow = followMax(source, low);
  const wantBack = followMax(source, source.contextWindow);
  record(`MD-17 replay ${name}: changing the Context window of ${source.id} (from pi) to ${low} drops its `
    + `"${FROM_PI}" and Max output follows (${wantLow.max}, ${MAX_SOURCE_TEXT[wantLow.from]}); changing it back to `
    + `${source.contextWindow} brings "${FROM_PI}" back and Max output returns to ${source.maxTokens}`,
  changed?.window === String(low) && !changed.pi.includes('contextWindow') && maxFollows(changed, wantLow)
    && back?.window === String(source.contextWindow) && back.pi.includes('contextWindow') && maxFollows(back, wantBack)
    && back.max === String(source.maxTokens), brief({ changed, back }));
}

/**
 * @brief 取消勾选一行取自 pi 的 Supports thinking（§6.2“From pi”：改成别的值就不写，改回又写，2026-10-26 补）：取消后这一格
 *        不写 From pi，再勾上又写，这一行的标记回到拉取时的样子（之后的 Add 照常）。
 * @param models 录下的结果里的行
 */
async function piThinkingToggle(page, { where, scope, models }) {
  const source = models.find((m) => !m.added && piOf(m).includes('reasoning')) ?? null;
  if (source === null) {
    record(`MD-17 replay ${where}: the recording has a row whose Supports thinking came from pi's model list`, false,
      brief(models.map((m) => m.id).slice(0, 10)));
    return;
  }
  const box = rowAt(page, scope, source.id).locator('input[data-field="reasoning"]');
  await box.setChecked(false);
  const off = (await checklistOf(page, scope)).rows.find((row) => row.id === source.id);
  await box.setChecked(true);
  const on = (await checklistOf(page, scope)).rows.find((row) => row.id === source.id);
  record(`MD-17 replay ${where}: unticking Supports thinking of ${source.id} (from pi) drops its "${FROM_PI}" on that `
    + `box only; ticking it again brings "${FROM_PI}" back`, off?.reasoning === false && !off.pi.includes('reasoning')
    && same(off.pi, piOf(source).filter((field) => field !== 'reasoning')) && on?.reasoning === true
    && same(on.pi, piOf(source)), brief({ off: off?.pi, on: on?.pi, want: piOf(source) }));
}

/**
 * @brief 同一格只写一个标记（§6.2“From pi”：同一格里不再写 Default，2026-10-26 补）：找一行 Max output 取自 pi、不超过
 *        16384 的（例如 OpenRouter 自己不报告最大输出的行，pi 给 4,096），把它的窗口改成 pi 的输出上限的两倍：Max output
 *        跟着窗口取 pi 的值（§4.3），这个数同时也是按新窗口算的默认值，这一格只写 From pi、不写 Default。之后改回录下的窗口。
 */
async function piDefaultCell(page, { where, scope, models }) {
  const source = models.find((m) => !m.added && piOf(m).includes('maxTokens') && m.maxTokens <= 16384) ?? null;
  if (source === null) {
    record(`MD-17 replay ${where}: the recording has a row whose Max output (at most 16384) came from pi's model list`,
      false, brief(models.map((m) => m.id).slice(0, 10)));
    return;
  }
  const window = source.maxTokens * 2;
  const both = (await editSize(page, scope, source.id, 'contextWindow', window)).row;
  await editSize(page, scope, source.id, 'contextWindow', source.contextWindow);
  record(`MD-17 replay ${where}: with the Context window of ${source.id} at ${window}, its Max output `
    + `${source.maxTokens} is both pi's value and the default for that window; the cell reads only "${FROM_PI}", `
    + 'not "Default"',
  both?.max === String(source.maxTokens) && unreportedMax(window) === source.maxTokens
    && both.pi.includes('maxTokens') && !both.defaults.includes('maxTokens'), brief(both));
}

/**
 * @brief 加入后的模型行（§8）：录下的档案有 catalog 的模型行写 (from pi)（行的比较已在 MD-13 里），悬停写录下的
 *        catalog.provider；md-glm-pi-card 加入的模型就是这样的一行。
 * @param refs 这次加入的模型
 */
function piModelRows(name, got, info, refs) {
  const want = expectModelRows(info).filter((w) => w.catalog);
  const bad = want.map((w) => {
    const row = got.find((item) => item.ref === w.ref);
    const ok = row && same(row.pi, w.pi) && row.piTitles.every((title) => title === piRowTitle(w.catalog.provider));
    return ok ? null : { ref: w.ref, got: row ? { pi: row.pi, titles: row.piTitles } : null, want: w.pi };
  }).filter(Boolean);
  const added = want.filter((w) => refs.includes(w.ref) && w.pi.length > 0).map((w) => w.ref);
  const need = name === PI_CARD;
  record(`MD-17 replay ${name} after the add: the model rows whose recorded profile has values from pi's model list `
    + `write "(from pi)" exactly where the configured value equals it, the hover reading "${piRowTitle('<provider>')}"`
    + `${need ? '; the added model is one of them' : ''}`, bad.length === 0 && (!need || added.length > 0),
  brief({ bad: bad.slice(0, 3), added }));
}

/** @brief 手填的行该显示的（§6.4）：勾上、"Entered by you"、两个数字是默认值并写 Default、没有 From pi、两个勾选框不勾。 */
const manualOk = (row) => Boolean(row) && row.picked && same(row.tags.map((tag) => tag.kind), ['entered'])
  && row.window === String(UNREPORTED_WINDOW) && row.max === String(unreportedMax(UNREPORTED_WINDOW))
  && same(row.defaults, ['contextWindow', 'maxTokens']) && row.pi.length === 0 && !row.reasoning && !row.image;

/**
 * @brief 手填的行不查 pi 的模型表（§6.4，2026-10-26）：在 Add a model ID 里填一个 pi 的模型表里这个地址有、录下的列表
 *        里没有的 id（测试自己从 pi-ai 读，按 pi 列出的顺序取第一个），Add to list 之后这一行写 Default、不写 From pi。
 *        这一行留在清单里；之后的 Clear selection 把它取消勾选，不加入。
 * @param where 检查名里的说明（录制名，或首次启动表单）
 * @param listed 录下的列表里的 id
 */
async function manualPi(page, { where, scope, baseUrl, listed }) {
  const origin = new URL(baseUrl).origin;
  const id = [...piEntriesAt(baseUrl).keys()].find((key) => !listed.includes(key)) ?? null;
  if (id === null) {
    record(`MD-17 replay ${where}: pi's model list has a model for ${origin} that the recorded list lacks (to type in `
      + 'Add a model ID)', false, brief({ listed: listed.length }));
    return;
  }
  const line = page.locator(`${scope} [data-testid="manual-model"]`);
  await line.locator('input[data-field="id"]').fill(id);
  await line.locator('[data-action="add-to-list"]').click();
  const row = (await checklistOf(page, scope)).rows.find((item) => item.id === id);
  record(`MD-17 replay ${where}: Add a model ID ${id} (pi's model list has it for ${origin}, the recorded list `
    + `doesn't) adds a ticked row "Entered by you" with Context window ${UNREPORTED_WINDOW} and Max output `
    + `${unreportedMax(UNREPORTED_WINDOW)} both "Default", no "${FROM_PI}" and thinking off (typed rows don't look up `
    + 'pi\'s model list)', manualOk(row), brief(row));
}

/** @brief 等设置页的模型行与 want 一致（说明开头、标记、提示），最多 10 秒；返回最后读到的。 */
async function rowsSettle(page, want) {
  const end = Date.now() + 10000;
  let got = await modelRowsOf(page);
  while (!rowsMatch(got, want) && Date.now() < end) {
    await sleep(200);
    got = await modelRowsOf(page);
  }
  return got;
}

/**
 * @brief 加入之后录下的每一条 models.saveModel（真实层在模型行上点的 Use，§8）照样点：按那时录下的 models.get 算出的
 *        提示里，Use 保存的模型与录下的命令相同的那一条；发出的命令与录下的相同，之后模型行与录制里下一个 models.get
 *        一致（标记与提示）。md-glm-pi-card 另查 piUsesCovered。
 */
async function cardUses(page, { name, fx }) {
  const used = [];
  let got = null;
  for (const [i, command] of writesOf(fx).slice(1).entries()) {
    const ref = `${command.providerId}/${command.model?.id}`;
    const row = expectModelRows(stateAfter(fx, i + 1)).find((w) => w.ref === ref);
    const hint = row?.hints.find((h) => canonical(h.model) === canonical(command.model));
    if (command.type !== 'models.saveModel' || !hint) {
      record(`MD-17 replay ${name}: recorded write ${i + 2} is a Use on a hint the model row shows`, false,
        brief({ command, hints: row?.hints.map((h) => h.kind) ?? null }));
      return;
    }
    const sent = await clickUse(page, ref, hint.kind);
    const want = expectModelRows(stateAfter(fx, i + 2));
    got = await rowsSettle(page, want);
    record(`MD-17 replay ${name}: Use on "${hint.text}" (${ref}) sends the recorded models.saveModel `
      + `(${brief(changeOf(row.model, hint.model), 120)}) and the model rows then match the recorded models.get: `
      + '"(default)", "(from pi)" and the hints', canonical(sent) === canonical(command) && rowsMatch(got, want),
    brief({ sent, got: got.map((g) => ({ ref: g.ref, meta: g.meta, pi: g.pi, hints: g.hints.map((h) => h.kind) })) }));
    used.push({ ref, kind: hint.kind });
  }
  if (name === PI_CARD) piUsesCovered(name, { fx, used, got });
}

/**
 * @brief md-glm-pi-card 的 Use（§8 表后三行，2026-10-26）：点过的提示含 pi 的三种；之后界面上没有一行有 pi 的提示，
 *        其中有一行的 Max output 是你设的（不是默认值、不等于 pi 的）：你设过的值不提示改成 pi 的。
 * @param got 最后一次 Use 之后读到的模型行；没有 Use 时为 null
 */
function piUsesCovered(name, { fx, used, got }) {
  const final = expectModelRows(stateAfter(fx, writesOf(fx).length));
  const own = final.filter((w) => w.catalog?.maxTokens && w.model.maxTokens !== w.catalog.maxTokens
    && w.model.maxTokens !== unreportedMax(w.model.contextWindow)).map((w) => w.ref);
  const kinds = [...new Set(used.map((item) => item.kind))];
  const shown = (got ?? []).filter((g) => g.hints.some((h) => PI_KINDS.includes(h.kind))).map((g) => g.ref);
  record(`MD-17 replay ${name}: the recorded Uses cover the three hints from pi's model list (${PI_KINDS.join(', ')}); `
    + 'afterwards no model row shows one, also not the row whose Max output you set (neither the default nor pi\'s)',
  got !== null && PI_KINDS.every((kind) => kinds.includes(kind)) && shown.length === 0 && own.length > 0
    && own.every((ref) => got.some((g) => g.ref === ref)), brief({ used, shown, own }));
}

/**
 * @brief §8 表第四行与 pi 的思考提示（models-settings.md "模型行的提示"，2026-10-26）：回放 PI_THINKING（synthetic：
 *        md-deepseek 最后的设置页，PI_THINKING_REF 的档案补了只有思考为真的 catalog，同 harness/main.jsx）。这一行只出
 *        "pi’s model list for Z.AI says this model supports thinking."，不出 "This model returned thinking content."；
 *        没有 catalog 的旧档案（legacy/fake-legacy）照旧有第四种；全部模型行照 expectModelRows。
 */
async function piThinkingCheck(page) {
  const info = structuredClone(stateAfter(readFixture('md-deepseek'), Infinity));
  info.profiles[PI_THINKING_REF] = { ...info.profiles[PI_THINKING_REF],
    catalog: { provider: 'Z.AI', contextWindow: null, maxTokens: null, reasoning: true } };
  await load(page, PI_THINKING);
  const want = expectModelRows(info);
  const got = await rowsSettle(page, want);
  await shot(page, 'md-deepseek-pi-thinking');
  const kinds = (ref) => got.find((g) => g.ref === ref)?.hints.map((h) => h.kind) ?? [];
  record(`MD-17 replay ${PI_THINKING} (synthetic: md-deepseek's last Settings, ${PI_THINKING_REF}'s profile given a `
    + 'catalog saying it thinks): that row shows "pi’s model list for Z.AI says this model supports thinking." with '
    + 'Use and not "This model returned thinking content." (one hint for one thing); the old profile without a catalog '
    + 'still shows the latter; every model row matches its profile and config',
  rowsMatch(got, want) && kinds(PI_THINKING_REF).includes('pi-reasoning')
    && !kinds(PI_THINKING_REF).includes('thinking-seen') && kinds('legacy/fake-legacy').includes('thinking-seen'),
  brief(got.map((g) => ({ ref: g.ref, hints: g.hints.map((h) => h.kind) }))));
}

/** @brief 模型行的 data-probe、状态行（data-state、文字、Verify again 的文字与是否可用）与行里的错误原文；行不在时为 null。 */
const statusRowOf = (page, ref) => page.evaluate((key) => {
  const row = document.querySelector(`[data-testid="model-row"][data-model="${key}"]`);
  const line = row?.querySelector('[data-testid="probe-status"]');
  const button = line?.querySelector('[data-action="verify"]');
  return row && { probe: row.dataset.probe ?? null, state: line?.dataset.state ?? null,
    text: line?.querySelector('span')?.textContent ?? null, button: button?.textContent ?? null,
    enabled: button ? !button.disabled : null,
    error: row.querySelector('.form-message.error[role="alert"]')?.textContent ?? null };
}, ref);

/** @brief 回放桥收到的 models.verify（status.modelWrites 里的）。 */
const verifyWrites = async (page) => (await writes(page)).filter((command) => command.type === 'models.verify');

/**
 * @brief 没有档案、不在探测的模型行（models-settings.md “Models 行”，2026-10-26 补，MD-18）：回放 NO_PROFILE（synthetic：
 *        md-deepseek 最后的设置页，NO_PROFILE_REF 的档案去掉，同 harness/main.jsx）。这一行 data-probe 为 unverified，
 *        状态行是出错的一类、文字正好是“Couldn’t verify”（没有冒号和原文），带 Verify again；点它发 models.verify
 *        （refs 只有这一行，不带 tests）。回放桥让下一条写命令失败（failModelWrite，synthetic）后再点：原文写在这一行里，
 *        状态行与 Verify again 仍在、按钮重新可用。
 */
async function noProfileCheck(page) {
  await load(page, NO_PROFILE);
  await page.locator(`[data-testid="model-row"][data-model="${NO_PROFILE_REF}"]`).waitFor({ timeout: 10000 });
  const first = await statusRowOf(page, NO_PROFILE_REF);
  await shot(page, 'md-deepseek-no-profile');
  record(`MD-18 replay ${NO_PROFILE} (synthetic: md-deepseek's last Settings without the profile of ${NO_PROFILE_REF}, `
    + 'not probing): the row\'s data-probe is unverified and its status line (data-state error) reads exactly '
    + '"Couldn’t verify" with "Verify again"', first?.probe === 'unverified' && first.state === 'error'
    && first.text === 'Couldn’t verify' && first.button === 'Verify again' && first.enabled === true
    && first.error === null, brief(first));
  const verify = page.locator(`[data-testid="model-row"][data-model="${NO_PROFILE_REF}"] [data-action="verify"]`);
  await verify.click();
  await page.waitForFunction(() => window.__replay.status.modelWrites.some((c) => c.type === 'models.verify'), null,
    { timeout: 10000 }).catch(() => {});
  const sent = await verifyWrites(page);
  record(`MD-18 replay ${NO_PROFILE}: "Verify again" sends models.verify for this model only, without tests `
    + `({ type: "models.verify", refs: ["${NO_PROFILE_REF}"] })`, same(sent, [{ type: 'models.verify',
    refs: [NO_PROFILE_REF] }]), brief(sent));
  await page.evaluate((message) => { window.__replay.failModelWrite = message; }, VERIFY_FAILURE);
  await verify.click();
  await page.waitForFunction(({ ref, text }) => document.querySelector(`[data-testid="model-row"][data-model="${ref}"] `
    + '.form-message.error[role="alert"]')?.textContent === text, { ref: NO_PROFILE_REF, text: VERIFY_FAILURE },
  { timeout: 10000 }).catch(() => {});
  const failed = await statusRowOf(page, NO_PROFILE_REF);
  const refused = await page.evaluate(() => window.__replay.status.failed.map((c) => c.type));
  record(`MD-18 replay ${NO_PROFILE}: when the models.verify command itself fails (synthetic: the replay bridge `
    + 'answers it with an error), its raw text shows in this row (role="alert"); the status line and "Verify again" '
    + 'stay and the button is usable again', failed?.error === VERIFY_FAILURE && failed.state === 'error'
    && failed.text === 'Couldn’t verify' && failed.button === 'Verify again' && failed.enabled === true
    && same(refused, ['models.verify']) && (await verifyWrites(page)).length === 1, brief({ failed, refused }));
}

/**
 * @brief 首次启动表单的清单（first-run.md "清单""Add a model ID"，2026-10-26）：回放 md-openrouter 录下的真实列表（回放
 *        桥的 config.get 改成首次启动，synthetic），在表单里填录下的 Base URL、Fetch models：每一行同 Add provider 的
 *        清单（expectRows，含 From pi），取自 pi 的行悬停写 pi 的提供商名；手填的行见 manualPi。
 */
async function firstRunPiCheck(page) {
  const { command, value: result } = pairs(readFixture('md-openrouter').steps, 'models.discover')[0];
  await page.goto(`${pathToFileURL(join(outDir, 'index.html')).href}?fixture=${FIRST_RUN}&speed=4&maxGap=600`);
  const scope = '[data-testid="connection-form"]';
  const form = page.locator(scope);
  await form.waitFor({ timeout: 20000 });
  await form.getByLabel('Base URL', { exact: true }).fill(command.target.baseUrl);
  await form.locator('[data-action="fetch-models"]').click();
  await form.locator('[data-testid="checklist"], [data-testid="list-error"]').first().waitFor({ timeout: 15000 });
  const s = await checklistOf(page, scope);
  await shot(page, 'md-openrouter-first-run');
  const want = expectRows(result.models);
  const got = s.rows.map(shapeOf);
  const bad = got.map((row, i) => (same(row, want[i]) ? null : { got: row, want: want[i] })).filter(Boolean);
  const pis = result.models.filter((m) => piOf(m).length > 0);
  const titled = pis.every((m) => s.rows.find((row) => row.id === m.id)?.piTitles
    .every((title) => title === piListTitle(m.catalog.provider)));
  record(`MD-17 replay first-run form (${FIRST_RUN}: the real md-openrouter list in the first-run form): Fetch models `
    + `shows "Models (${result.models.length})" and one row per recorded model with its values; the ${pis.length} `
    + `rows whose values came from pi's model list read "${FROM_PI}" on exactly those values, the hover reading `
    + `"${piListTitle('<provider>')}"; "Default" only on unreported defaults; the recording has such rows`,
  s.title === `Models (${result.models.length})` && got.length === want.length && bad.length === 0 && titled
    && pis.length > 0, brief({ rows: got.length, bad: bad.slice(0, 3), pi: pis.map((m) => m.id).slice(0, 10) }));
  await piDefaultCell(page, { where: 'first-run form', scope, models: result.models });
  await manualPi(page, { where: 'first-run form', scope, baseUrl: command.target.baseUrl,
    listed: result.models.map((m) => m.id) });
}

// ---------- md-shapes：id 含空格、空列表、Ollama 的清单与 Use 后的重新探测（MD-07、MD-13；synthetic） ----------

/**
 * @brief 页面载入前装上（page.addInitScript，每次载入都在回放页面的脚本之前跑）：window.mori 被赋值时包一层它的
 *        onEvent，记下界面挂上的监听（window.__mdListeners），feedEvent 把录下的事件交给它们。回放桥的其他行为不变：
 *        命令照旧由它回答，它自己回放的事件照旧经它原来的 onEvent 送达。
 */
function captureListeners() {
  let bridge;
  Object.defineProperty(window, 'mori', { configurable: true, get: () => bridge, set(value) {
    const listeners = new Set();
    const onEvent = value.onEvent;
    value.onEvent = (listener) => {
      listeners.add(listener);
      const off = onEvent(listener);
      return () => { listeners.delete(listener); off(); };
    };
    window.__mdListeners = listeners;
    bridge = value;
  } });
}

/** @brief 模型行的选择器：行上的 data-probe 是 tool calling 的验证状态（verifying、reverifying、verified…，2026-10-26 起）。 */
const toolSel = (ref) => `[data-testid="model-row"][data-model="${attr(ref)}"]`;

/**
 * 状态行的文字（models-settings.md "Models 行"，2026-10-26）：能用的模型（verified、重新验证中）没有状态行；第一次验证中
 * "Verifying…"。本测试只回放 Use 之后的重新探测，用不到失败与出错两种
 */
const STATUS_TEXT = { verified: '', reverifying: '', verifying: 'Verifying…' };
/** @brief 比较形式："<data-probe> | <状态行的文字>"。 */
const toolLine = (state) => `${state} | ${STATUS_TEXT[state] ?? `(no expectation for ${state})`}`;

/** @brief ref 这一行此刻的 tool calling（toolLine 的形式）；没有这一行时为 null。 */
const toolNow = (page, ref) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  return el ? `${el.dataset.probe} | ${el.querySelector('[data-testid="probe-status"]')?.textContent ?? ''}` : null;
}, toolSel(ref));

/**
 * @brief 把录下的一个事件信封原样交给界面挂上的监听，等界面重画再读 ref 这一行的 Tool calling：先等一个宏任务，
 *        再等到读到 want，最多 2 秒，之后照实返回（不等于 want 时检查失败）。
 * @return 这时的 Tool calling（toolLine 的形式）；没有这一行时为 null
 */
const feedEvent = (page, { envelope, ref, want }) => page.evaluate(async ({ env, sel, wanted }) => {
  for (const listener of window.__mdListeners ?? []) listener(structuredClone(env));
  const read = () => {
    const el = document.querySelector(sel);
    return el ? `${el.dataset.probe} | ${el.querySelector('[data-testid="probe-status"]')?.textContent ?? ''}` : null;
  };
  const end = Date.now() + 2000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 30));
  } while (read() !== wanted && Date.now() < end);
  return read();
}, { env: envelope, sel: toolSel(ref), wanted: want });

/**
 * @brief 行上 data-probe 该是的（models-settings.md "Models 行""重新验证中"，独立实现）：running 里有它、档案完成过
 *        （不在探测中，tool_calling 为 verified 或 failed）时 reverifying；running 里有它或还在探测中时 verifying；
 *        否则为档案的 tool_calling.state，没有档案时 unverified（2026-10-26 WP-02 评审改，原来没有档案时总是 verifying）。
 */
function expectTool(profile, running) {
  const verified = Boolean(profile) && profile.status !== 'probing'
    && ['verified', 'failed'].includes(profile.tool_calling.state);
  if (running && verified) return 'reverifying';
  if (running || profile?.status === 'probing') return 'verifying';
  return profile?.tool_calling.state ?? 'unverified';
}

/** @brief 关掉 Add provider 表单（拉取后底部的 Cancel），等它消失。 */
async function closeForm(page) {
  await page.locator('[data-testid="provider-form"] [data-action="close-form"]').click();
  await page.getByTestId('provider-form').waitFor({ state: 'detached', timeout: 10000 });
}

/** @brief 一行里四个可改的字段（两个数字框、两个勾选框）此刻能不能用。 */
const fieldsOf = (page, scope, id) => rowAt(page, scope, attr(id)).locator('input[data-field]')
  .evaluateAll((items) => items.map((el) => ({ field: el.dataset.field, disabled: el.disabled })));

/**
 * @brief id 含空格的列表（vllm 默认形状，类型不明，§6.2、§4.3）：那一行列出、不勾、勾选框不可用、标
 *        "Can’t add this model: the ID contains spaces"，另外四个字段仍可改；能加入的只有另一行，所以它勾上；
 *        Clear selection 之后 Select all 只勾能勾的那一行。
 */
async function spacedList(page, discover) {
  const scope = await fetchNew(page, discover.command.target.baseUrl);
  const s = await checklistOf(page, scope);
  const want = expectRows(discover.value.models);
  const bad = s.rows.map(shapeOf).find((row) => row.tags.some((tag) => tag.kind === 'unusable'));
  const usable = want.filter((row) => !row.pickDisabled).map((row) => row.id);
  const fields = bad ? await fieldsOf(page, scope, bad.id) : [];
  record(`MD-07 replay md-shapes: the ID with a space ("${bad?.id}") is listed, not ticked, its pick box `
    + 'unavailable, tagged "Can’t add this model: the ID contains spaces", and its Context window, Max output, '
    + `Supports thinking and Image input stay editable; the only row that can be added is ticked ("${addLabel(1)}")`,
  Boolean(bad) && same(s.rows.map(shapeOf), want) && !bad.picked && bad.pickDisabled
    && same(bad.tags, [{ kind: 'unusable', text: 'Can’t add this model: the ID contains spaces' }])
    && fields.length === 4 && fields.every((f) => !f.disabled) && usable.length === 1
    && same(s.rows.filter((row) => row.picked).map((row) => row.id), usable) && s.add?.text === addLabel(1)
    && !s.add.disabled, brief({ got: s.rows.map(shapeOf), want, fields, add: s.add }));
  await page.locator(`${scope} [data-action="clear-selection"]`).click();
  const cleared = await cardPicks(page, scope);
  await page.locator(`${scope} [data-action="select-all"]`).click();
  const all = await cardPicks(page, scope);
  record(`MD-07 replay md-shapes: Clear selection leaves nothing ticked ("${addLabel(0)}", unavailable); Select all `
    + `ticks only the row that can be added, not "${bad?.id}" ("${addLabel(1)}")`, cleared.picked.length === 0
    && cleared.add?.text === addLabel(0) && cleared.add.disabled && same(all.picked, usable)
    && all.add?.text === addLabel(1), brief({ cleared, all }));
  await closeForm(page);
}

/**
 * @brief 空列表（§6.2；models-settings.md "列表为空"）：Models (0)，下面一句"The server didn’t list any models."，再下面
 *        是 Add a model ID；没有行、过滤框和列表错误；Select all、Clear selection 同有列表；Add models 不可用。
 */
async function emptyList(page, discover) {
  const scope = await fetchNew(page, discover.command.target.baseUrl);
  const s = await checklistOf(page, scope);
  // 上下顺序：标题、这一句、Add a model ID（models-settings.md "列表为空"）
  const below = await page.evaluate((root) => {
    const base = document.querySelector(root);
    const title = base.querySelector('[data-testid="checklist"] h4');
    const line = [...base.querySelectorAll('[data-testid="checklist"] p')]
      .find((p) => p.textContent === 'The server didn’t list any models.');
    const manual = base.querySelector('[data-testid="manual-model"]');
    const after = (a, b) => Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return after(title, line) && after(line, manual);
  }, scope);
  record('MD-07 replay md-shapes: the recorded empty list (no list error) shows "Models (0)", below it "The server '
    + 'didn’t list any models.", and below that Add a model ID; no rows, filter box or list error; Select all and '
    + `Clear selection as with a list; the button reads "${addLabel(0)}" and is unavailable`,
  discover.value.models.length === 0 && discover.value.listError === null && s.title === 'Models (0)' && s.empty
    && below && s.rows.length === 0 && s.filter === null && s.error === null && s.selectAll && s.clear
    && s.add?.text === addLabel(0) && s.add.disabled, brief({ ...s, below }));
  await closeForm(page);
}

/**
 * @brief Ollama 形状的清单（§6.2、§4.2）：服务报告每行都是聊天模型，都勾上；只有训练窗口的行带 trained_window 的
 *        提示，没有工具能力的行带 no_tools；没报告、仍是默认值的 Max output 写 Default。照录制改小一行的窗口：没报告的
 *        Max output 随之变成新窗口的默认值（§4.3），Default 留着；Add 发出录制里的 models.saveProvider。
 */
async function ollamaList(page, fx, discover) {
  const scope = await fetchNew(page, discover.command.target.baseUrl);
  const s = await checklistOf(page, scope);
  const want = expectRows(discover.value.models);
  const hinted = (kind) => want.filter((row) => row.hints.some((hint) => hint.kind === kind)).map((row) => row.id);
  record(`MD-07 replay md-shapes: the Ollama list ticks every row the server reports as a chat model `
    + `("${addLabel(want.length)}"); "${HINT_TEXT.trained_window}" on the row with only a trained window `
    + `(${hinted('trained_window').join(', ')}); "${HINT_TEXT.no_tools}" on ${hinted('no_tools').join(', ')}; `
    + '"Default" next to every Max output (Ollama reports none; each is the default for its window)',
  same(s.rows.map(shapeOf), want) && want.every((row) => row.picked && row.defaults.includes('maxTokens'))
    && hinted('trained_window').length === 1
    && hinted('no_tools').length === 1 && s.add?.text === addLabel(want.length) && !s.add.disabled,
  brief({ got: s.rows.map(shapeOf), want, add: s.add }));
  const [saved] = writesOf(fx);
  const lowered = saved.models.find((m) => m.contextWindow < discover.value.models
    .find((row) => row.id === m.id).contextWindow);
  const edit = await editSize(page, scope, lowered.id, 'contextWindow', lowered.contextWindow);
  const max = unreportedMax(lowered.contextWindow);
  record(`MD-07 replay md-shapes: lowering the Context window of ${lowered.id} to ${lowered.contextWindow} makes `
    + `the unreported Max output ${max} (the default for it) and keeps "Default"`,
  edit.row?.window === String(lowered.contextWindow)
    && edit.row.max === String(max) && edit.row.defaults.includes('maxTokens') && lowered.maxTokens === max,
  brief(edit));
  const { command, closed } = await clickAdd(page, scope, scope);
  record(`MD-07 replay md-shapes: "${addLabel(saved.models.length)}" sends the recorded models.saveProvider (every `
    + 'row in list order, the lowered window); the form closes', closed && canonical(command) === canonical(saved),
  brief({ command, saved }));
}

/**
 * @brief 加入后的模型行（MD-13，录制里加入之后最后一个 models.get，探针都完成了）：(default) 与 §8 的提示照
 *        档案；只有训练窗口的模型 reported 窗口为 null（§7.2），窗口是训练窗口、不是默认值：不写 (default)（2026-10-26），
 *        没有窗口的提示；窗口在清单里
 *        改小过的模型有"Server reports a context window of …"。
 * @return 期望的模型行（expectModelRows）
 */
function shapesRows(got, info, discover) {
  const want = expectModelRows(info);
  // 加入的 Ollama 模型（准备里的 Legacy endpoint 的旧档案另有它自己的提示）
  const added = want.filter((w) => discover.value.models.some((m) => m.id === w.model.id));
  const trained = discover.value.models.filter((m) => m.hints.includes('trained_window')).map((m) => m.id);
  const byId = (id) => added.find((w) => w.model.id === id);
  const lowered = added.filter((w) => w.hints.some((h) => h.kind === 'context')).map((w) => w.model.id);
  // 清单里改过窗口的模型：保存的窗口与列表里的不同（按录下的配置）
  const edited = added.filter((w) => w.model.contextWindow !== discover.value.models
    .find((m) => m.id === w.model.id).contextWindow).map((w) => w.model.id);
  record(`MD-13 replay md-shapes: after the add every model row writes "(default)" exactly where its recorded `
    + `profile has no reported value and the value is the default; the model with only a trained window `
    + `(${trained.join(', ')}) has no "(default)" after its Context window (the trained window is not the default) and `
    + 'no context hint; only the model whose window was lowered in the checklist '
    + `(${edited.join(', ')}) shows "Server reports a context window of …" with Use; the added models have no `
    + 'other hints', rowsMatch(got, want) && added.length === discover.value.models.length && trained.length === 1
    && !byId(trained[0])?.defaults.includes('contextWindow') && byId(trained[0]).hints.length === 0
    && edited.length === 1 && same(lowered, edited) && added.reduce((n, w) => n + w.hints.length, 0) === 1, brief({ got,
    want: want.map((w) => ({ ref: w.ref, meta: w.meta, defaults: w.defaults, hints: w.hints.map((h) => h.kind) }))
  }));
  return want;
}

/** @brief 点 ref 这一行的一条提示的 Use，等回放桥收到写命令、这条提示消失（Use 之后的 models.get 读到新值）。 */
async function clickUse(page, ref, kind) {
  const before = (await writes(page)).length;
  const hint = `[data-testid="model-row"][data-model="${attr(ref)}"] [data-testid="model-hint"][data-kind="${kind}"]`;
  await page.locator(`${hint} [data-action="use-reported"]`).click();
  await page.waitForFunction((n) => window.__replay.status.modelWrites.length > n, before, { timeout: 10000 })
    .catch(() => {});
  await page.locator(hint).waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  return (await writes(page))[before] ?? null;
}

/**
 * @brief Use 之后的重新探测（MD-13，models-settings.md "Use 成功""重新验证中"）：把录制里 Use 之后后台进程转发的事件
 *        按顺序交给界面，每个事件之后行上的 data-probe 与状态行照它的档案与 running（expectTool、STATUS_TEXT）：
 *        先是 verified，其中有 reverifying，最后是 verified，能用的模型一直没有状态行；录下的最后一个档案的 probedAt 比 Use 之后的 models.get
 *        里的新（这次 Use 之后确实重新探测出了新结果）。
 * @param at 录制里 Use 发出的 models.saveModel 的位置
 */
async function reprobeCheck(page, fx, at, ref) {
  const envelopes = fx.steps.slice(at + 1).filter((step) => step.envelope).map((step) => step.envelope);
  const before = stateAfter(fx, 2).profiles[ref];
  const states = [expectTool(before, false)];
  for (const { event } of envelopes) {
    states.push(event.type !== 'mori.profiles' ? states.at(-1)
      : expectTool(event.profiles[ref], event.running.some((item) => item.ref === ref)));
  }
  const expected = states.map(toolLine);
  const seen = [await toolNow(page, ref)];
  for (const [i, envelope] of envelopes.entries()) {
    seen.push(await feedEvent(page, { envelope, ref, want: expected[i + 1] }));
  }
  const last = envelopes.findLast(({ event }) => event.type === 'mori.profiles')?.event.profiles[ref];
  await shot(page, 'md-shapes-reprobed');
  record(`MD-13 replay md-shapes: Use re-probes ${ref}: fed the ${envelopes.length} events the background process `
    + 'sent after the recorded Use, the row\'s data-probe follows each one (verified, then reverifying while the probe '
    + 'runs, then verified again) with no status line on this usable model, and the last profile carries a newer '
    + 'probe time than the one read after Use',
  same(seen, expected) && states[0] === 'verified' && states.includes('reverifying') && states.at(-1) === 'verified'
    && last?.probedAt > before?.probedAt,
  brief({ seen: seen.join(' > '), expected: expected.join(' > '), probedAt: [before?.probedAt, last?.probedAt] }));
}

/**
 * @brief §8 的 Use 与重新探测（MD-13）：Use 发出录制里的 models.saveModel（也是按 §8 表算出的命令）；之后设置页是录制里
 *        Use 之后的 models.get：提示消失、窗口为新值；再照录下的事件检查重新探测（reprobeCheck）。
 */
async function shapesUse(page, fx, want) {
  const at = fx.steps.findIndex((step) => step.command?.type === 'models.saveModel');
  const recorded = fx.steps[at].command;
  const ref = `${recorded.providerId}/${recorded.model.id}`;
  const row = want.find((w) => w.ref === ref);
  const hint = row?.hints.find((h) => h.kind === 'context');
  const command = await clickUse(page, ref, 'context');
  const after = expectModelRows(stateAfter(fx, 2)).find((w) => w.ref === ref);
  const got = (await modelRowsOf(page)).find((g) => g.ref === ref);
  record(`MD-13 replay md-shapes: Use on "${hint?.text}" (${ref}) saves at once: models.saveModel with `
    + `${brief(changeOf(row?.model ?? {}, hint?.model ?? {}), 120)} and no thinkingLevel, the command the real App `
    + 'got; the hint goes away and the row reads the new window', Boolean(hint) && canonical(command)
    === canonical(recorded) && canonical(command) === canonical({ type: 'models.saveModel', providerId: row.provider,
    model: hint.model }) && Boolean(got) && metaMatch([got], [after]) && hintsMatch([got], [after])
    && after.hints.length === 0 && after.model.contextWindow === hint.model.contextWindow,
  brief({ command, recorded, got, after }));
  await reprobeCheck(page, fx, at, ref);
}

/** @brief md-shapes：id 含空格的列表、空列表、Ollama 的清单与 Add、加入后的模型行、Use 与重新探测。 */
async function shapesCheck(page) {
  const fx = readFixture('md-shapes');
  const [spaced, empty, olla] = pairs(fx.steps, 'models.discover');
  await load(page, fx.name);
  await untilCards(page, stateAfter(fx, 0).config.providers.map((p) => p.id));
  await spacedList(page, spaced);
  await emptyList(page, empty);
  await ollamaList(page, fx, olla);
  const info = stateAfter(fx, 1);
  await untilCards(page, info.config.providers.map((p) => p.id));
  await shot(page, 'md-shapes-added');
  const want = shapesRows(await modelRowsOf(page), info, olla);
  await shapesUse(page, fx, want);
}

// ---------- 执行 ----------

/** 每个录制：名字、覆盖的编号、检查 */
const FIXTURES = [
  { name: 'md-openrouter', ids: ['MD-07'], check: openrouterCheck },
  // synthetic：md-openrouter 的真实列表放进首次启动表单（file 是它用的录制）
  { name: 'md-openrouter-first-run', file: 'md-openrouter', ids: ['MD-17'], check: firstRunPiCheck },
  { name: 'md-glm', ids: ['MD-07', 'MD-15'], check: glmCheck },
  { name: 'md-deepseek', ids: ['MD-07', 'MD-13', 'MD-15'], check: deepseekCheck },
  // synthetic：md-deepseek 最后的设置页，一个档案补了取自 pi 的 catalog
  { name: 'md-deepseek-pi-thinking', file: 'md-deepseek', ids: ['MD-17'], check: piThinkingCheck },
  // synthetic：md-deepseek 最后的设置页，一个模型没有档案（2026-10-26 补）
  { name: 'md-deepseek-no-profile', file: 'md-deepseek', ids: ['MD-18'], check: noProfileCheck },
  { name: 'md-shapes', ids: ['MD-07', 'MD-13'], check: shapesCheck },
];

const known = [...FIXTURES, ...cardFixtures()];
const chosen = known.filter((f) => !only || only.includes(f.name));
// MD-17 的回放层只有这一份录制（md-real.mjs --only glm-pi 录）：全部回放时它不存在记一条失败（不造假录制）
if (!only && !known.some((f) => f.name === PI_CARD)) {
  record(`MD-17 replay fixture missing: tests/fixtures/discovery/ui/${PI_CARD}.json (record it with `
    + 'node tests/ui/md-real.mjs --only glm-pi)', false, 'no recording yet');
}
// --only 里不是任何录制的名字（例如没有这个文件的 md-*-card）：记一条失败，部分运行不会因为一条检查都没有而通过
for (const name of (only ?? []).filter((item) => !known.some((f) => f.name === item))) {
  record(`MD-07 replay --only ${name}: names a recording (${FIXTURES.map((f) => f.name).join(', ')} or a file `
    + 'tests/fixtures/discovery/ui/md-*-card.json)', false, 'no such recording');
}
const present = chosen.filter((f) => existsSync(join(fixtureDir, `${f.file ?? f.name}.json`)));
for (const f of chosen.filter((item) => !present.includes(item))) {
  for (const id of f.ids) {
    record(`${id} replay fixture missing: tests/fixtures/discovery/ui/${f.file ?? f.name}.json (record it with `
      + 'md-record.mjs)', false, 'no recording yet');
  }
}
if (present.length) {
  await buildHarness();
  // 回放页面的数据目录（同 m6-replay.mjs）：跑完删掉
  const harnessData = mkdtempSync(join(tmpdir(), 'mori-harness-md-'));
  const app = await electron.launch({ args: [join(harnessDir, 'main.cjs')], cwd: appRoot,
    env: { ...process.env, MORI_HARNESS_INDEX: join(outDir, 'index.html'), MORI_HARNESS_DATA: harnessData } });
  try {
    const page = await app.firstWindow();
    // md-shapes 把录下的事件交给界面的监听（captureListeners）；每次载入都装，对别的录制不改变什么
    await page.addInitScript(captureListeners);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()); });
    for (const f of present) {
      const errorsBefore = pageErrors.length;
      try {
        await f.check(page);
      } catch (error) {
        record(`${f.ids[0]} replay ${f.name}: flow`, false, oneLine(error?.stack ?? error, 600));
        await shot(page, `${f.name}-error`);
      }
      await sleep(200);
      const errors = pageErrors.slice(errorsBefore);
      record(`${f.ids[0]} replay ${f.name}: the page has no errors`, errors.length === 0,
        errors.slice(0, 5).join(' | '));
    }
  } finally {
    await app.close().catch(() => {});
    rmSync(harnessData, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
process.exitCode = write(resultFile) ? 0 : 1;
