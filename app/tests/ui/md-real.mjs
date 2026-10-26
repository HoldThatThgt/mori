// 一键拉取模型的真实层（docs/specs/model-discovery.md §13.1“真实”一行，§13.2 MD-14）：真正的 Mori 对真实的 DeepSeek、GLM
// 与 OpenRouter，全部经界面操作（设置 → Models）。数据目录有两种来源，之后的驱动相同：
// - --source 方式：负责人在 Mori 里保存过 DeepSeek 与 GLM（各有 key）的数据目录。只复制加密的 key 文件，从不读、不打印
//   key（准备与代理的做法见 md-real-helpers.mjs）。
// - key 方式：不给 --source，环境变量 MD_REAL_DEEPSEEK_KEY、MD_REAL_GLM_KEY、MD_REAL_OPENROUTER_KEY 都有值（地址
//   MD_REAL_DEEPSEEK_URL 默认 https://api.deepseek.com，MD_REAL_GLM_URL 默认 https://api.z.ai/api/anthropic）。脚本一启动就
//   把这几个变量读进内存并从 process.env 删掉，之后启动的 Mori 与 md-replay.mjs 拿不到。然后只经界面建一个新的数据目录：
//   首次启动表单填 DeepSeek 的 Base URL 与 API key → Fetch models → 只勾 DEEPSEEK_DOCS 里服务列出的第一个模型 →
//   Test connection（连上，等它的探针跑完）；重新打开 Mori，设置 → Models → Add provider：GLM（Base URL 与
//   key → Fetch models → 清单或列表错误 → 服务没列出 GLM-5.3 时用 Add a model ID 手填 → Add）与 OpenRouter
//   （https://openrouter.ai/api/v1 与 key → Detected: OpenRouter → 只勾第一个免费的、服务列出工具支持的模型
//   （freeToolRow：id 以 ":free" 结尾，行上没有 no_tools 提示），探针不花钱 → Add），等它们的探针跑完再关掉。
//   key 只输进 Mori 自己的密码框（输入之前核对框的 type 是 password，不是时不输入、记一条失败），由 Mori 加密保存；
//   这三步各记一条“MD-14 real setup”检查。之后把这个目录当作 --source 的数据目录跑下面的驱动（卡上的 Fetch models 用
//   保存的 key）。检查的名字与 detail、结果文件、fixture 写出之前都把 key 换成 ***（fixture 里出现 key 时另记为问题、
//   写到 rejected）；每次截图之前读窗口的文字，出现 key 时不截；最后一条检查核对窗口的文字、Mori 的输出和这次用过的
//   数据目录里（加密的 credentials.json 之外）都没有 key 的明文。运行它的进程从负责人的 env 文件读出 key 放进环境变量
//   （不回显：例如 set +x 的包装脚本用 awk 读出后 export）。
//   建目录的步骤与问题清单与 v1-models-real.mjs 的 key 方式共用（模型层规格 §14.1 的 2026-10-24 补，选项 A），在
//   v1-real-helpers.mjs：typeKey、firstRunDeepSeek、firstRunProblems、addProviderUi、tickOnly、chooseGlm、
//   glmAddProblems、addedProblems、savedProblems、providerBrief、地址的默认值 KEY_MODE_URLS 与 PROBE_MS。这里自己的是
//   OpenRouter 只勾哪一行（chooseFree）、检查的名字与 detail、MD_REAL_* 环境变量（地址经 baseUrl 传进去）、截图前的
//   key 核对（shot）与换成 *** 的做法。
// 第一次启动（直接对真实地址）：
//   deepseek：DeepSeek 卡上的 Fetch models（用已保存的 key）→ 清单里文档列出的模型的 Context window、Max output、
//             Supports thinking、Image input 与 DeepSeek 官方文档一致（DEEPSEEK_DOCS 写明地址与核对日期）；已在提供商里的
//             标 Added；只勾一个文档模型、把它的 Context window 改小（Max output 按 §4.3 跟着变）→ Add 1 model → 探针跑完
//             （ready，第 0 步读到 kind deepseek 和文档的值）→ 模型行出“Server reports a context window of …”。
//   openrouter：数据目录里有 OpenRouter 的提供商时（key 方式总有）用卡上的 Fetch models，没有时 Add provider 填
//             https://openrouter.ai/api/v1、不填 key → 几百行的清单（Models (N)，N ≥ 200）、（Add provider 时）Detected:
//             OpenRouter → 过滤框按那个免费模型的厂商前缀过滤（不分大小写）→ 只勾第一个还没加入的免费、有工具支持的
//             模型（freeToolRow；有 key 时加入后的探针不花钱）→ Add 1 model，配置里有它。
//   glm：GLM 卡上的 Fetch models → 清单或列表错误（§6.3 的文字）→ Add a model ID 手填 GLM-5.3（列在列表错误下面或
//             清单末尾；服务列出了它时手填得到重复的错误，改勾那一行）→ Add 1 model → 探针跑完（ready，档案有第 0 步的
//             reported）。
//   glm-pi（2026-10-26，WP-15，负责人走查回答 1，§4.4、MD-17）：GLM 卡上的 Fetch models → 每一行按 pi 自带的模型表
//             （测试自己从 pi-ai 读，md-real-helpers.mjs piEntriesAt）算出该显示的：服务没报告、pi 有这个 id 时窗口、
//             最大输出、思考取 pi 的并标 From pi（悬停写 pi 的提供商名），其余默认值标 Default → Add a model ID 填
//             pi 有、z.ai 的列表没有的 id（写 Default、不写 From pi，不加入）→ 勾 glm-5.3-flash（Max output 改成默认值）
//             与 glm-5.2（窗口改回 128000、Max output 你设的 8192、不勾思考），Add 2 models → 探针跑完 → 模型行的
//             (from pi)、(default) 与 §8 表后三行的提示 → 依次点 pi 的提示的 Use（三种都点到；你设的 8192 不被提示）→
//             重新探测跑完；档案没有报告的窗口、有效窗口是配置的。全程录成回放 fixture md-glm-pi-card.json（md-replay.mjs
//             的 MD-17 回放层）。最后在 glm-5.3-flash（配置是 pi 的 1,000,000 / 131,072 / 思考）上开新会话发一轮，
//             回复完成、没有错误卡（2026-10-26 审查后补：这一轮发出 max_tokens 131,072；2026-10-26 覆盖审查补：临时项目里
//             的 pi 扩展在 before_provider_request 里记下请求体，查这一轮的 max_tokens 就是它，打开项目时选信任；会话之前
//             先用 Edit 把 flash 的 Max output 改成别的值再改回，查“(from pi)”随之消失、又出现）。
// 回放用的 fixture（§13.1 回放层：DeepSeek 的清单与加入后（清单里把窗口改小）设置页的 models.get、mori.profiles，
// GLM 的列表或列表错误）：格式同 md-record.mjs（外层 source、note、name、description、covers、recorded、address、
// endpoint、model、notes、recordedAt、steps；步骤 { t, command } / { t, result } / { t, envelope }，界面发的写命令为
// { t, note, command }）。
// 页面里的录制器记下后台进程转发的全部事件和它自己发的命令：开头像界面一样读会话列表与设置；界面拉取之后再发一次卡上
// 同一个 models.discover（window.mori 冻结，包不住界面自己的调用）；界面的 Add 记一步 { note, command }（command 是
// 界面发的 models.addModels，按界面的操作写出，再核对配置里加在最后的正是这些模型；回放桥按它数写命令的条数），之后像
// 界面一样读 models.get，探针跑完后读 config.get 与 models.get。核对通过时写到
// tests/fixtures/discovery/ui/md-deepseek-card.json 与 md-glm-card.json，不通过时写到
// test-results/md-real/<名字>.rejected.json。md-record.mjs 的 md-deepseek.json（synthetic）不覆盖：它的回放检查
// 依赖合成端点的场景（按地址两次 Add provider、typed 列表、§8 的五种提示、Legacy 卡），保存的 key 只能经卡上的
// Fetch models（kind provider）使用，真实的 DeepSeek 录不出那个场景。md-replay.mjs 回放 ui/ 里全部 md-*-card.json
// （MD-07、MD-13）；这里写下卡上的录制之后接着跑 node tests/ui/md-replay.mjs（不带 --only，全部录制；它重写
// test-results/md-replay.json），把结果记成一条"MD-14 real replay"检查：真实录制能回放。2026-10-26（测试分层第 2 条）：
// md-real 带 --only 时只回放这次写下的卡上录制（md-replay.mjs --only <这些录制>，结果在 md-partial-replay.json）。
// 第二次启动（record，录响应体样本，§13.1“真实录制”）：另一份复制出的数据目录里 DeepSeek、GLM 的地址改指本机
// 127.0.0.1:4881 的转发代理（/p/<提供商 id><原来的路径>），代理把请求原样转发到原来的 origin：请求头（含 key）与响应头
// 原样转发、都不存；只给列表请求（GET、路径以 /models 结尾）留一份响应体，存“状态 + 响应体”（响应体里出现请求带的 key
// 时换成 ***），另记带没带 Authorization 头（只记有没有，核对“用已保存的 key”）。卡上点 Fetch models，
// 代理录下的写成 tests/fixtures/discovery/bodies/deepseek-models.json（替换手写的）与 glm-models-<n>.json（第 n 个列表
// 地址，§3.2 的顺序），信封同已有的真实录制（source、recorded、url、note、status、body）。经代理时主机是 127.0.0.1，
// §3.3 第 2 步按主机认不出 DeepSeek（种类为 unknown），所以回放 fixture 在第一次启动里直接对真实地址录。
// 测试准备（synthetic test setup，只改复制出的配置）：GLM 的提供商已有 GLM-5.3 时先去掉（唯一的模型时改名），DeepSeek
// 已有文档的全部模型时去掉最后一个；见 md-real-helpers.mjs。
// 以下情况立即以退出码 1 结束，不启动 Mori、不写结果文件：带值的参数没给值、--only 为空或有不认识的名字、--exe 不存在；
// --source 方式下 --source 不存在或不合格（缺 model-config.json、credentials.json、Local State，找不到 DeepSeek 或 GLM 的
// 提供商，提供商没有保存的 key）；不给 --source 时三个 key 的环境变量缺任何一个、地址的环境变量不是 http(s) URL，或给了
// --deepseek、--glm（只用于 --source）。测试准备（复制、改名）是测试自己做的：不合格时记一条失败，合格时只打印做了什么，
// 不算一条检查。
// 用法（在 app/ 下，用 out/ 的构建或 MORI_APP_DIR 指的构建）：
//   node tests/ui/md-real.mjs --source <数据目录> [--exe <Mori.exe>] [--only deepseek,openrouter,glm,glm-pi,record]
//        [--deepseek <提供商 id>] [--glm <提供商 id>]
//   key 方式（环境变量里有三个 key）：node tests/ui/md-real.mjs [--exe <Mori.exe>]
//        [--only deepseek,openrouter,glm,glm-pi,record]
// 结果写到 test-results/md-real(-packaged).json（--only 时 md-partial-real…，不计入覆盖检查），截图在
// test-results/md-real(-packaged)/。端口：真实层的 4880–4889 里用 4881（只在 record 那次启动里监听）。

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  appRoot, arg, createRecorder, launch, oneLine, prepareProject, sleep,
} from './lib.mjs';
import {
  addModelId, bodyEnvelope, brief, cardIds, cardOf, checkSource, DEEPSEEK_DOCS, fetchedState, findSecrets, freeToolRow,
  GLM_MANUAL_ID, installRecorder, localDate, manualState, modelRowOf, modelRowState, modelsGet, OPENING,
  OPENROUTER_BASE, piEntriesAt, pickOnly, pollFor, prepareDirect, prepareRecord, readJson, readRows, recBegin, recCmd,
  recEnd, recUiCommand, redactor, rowOf, rowsFollow, startListProxy, stopListProxy, thousands, UNREPORTED_WINDOW,
  unreportedMax, waitFetched, waitModelRow, waitProbed,
} from './md-real-helpers.mjs';
// key 方式建目录的步骤与问题清单（与 v1-models-real.mjs 共用）；PROBE_MS 为一个模型的自动探针跑完的时限（15 分钟）
import {
  activeSessionFile, addedProblems, addProviderUi, assistantMessages, cardCounts, chooseGlm, chooseRange,
  firstRunDeepSeek, firstRunProblems, glmAddProblems, KEY_MODE_URLS, leaveSettings, openModelsSettings,
  openProjectFolder, PROBE_MS, providerBrief, tickOnly,
} from './v1-real-helpers.mjs';
// glm-pi 的会话一轮（2026-10-26，WP-15 审查后补）：发消息、等本轮结束；临时项目里有记请求体的扩展，打开时要选信任
import { pageHelpers } from './page.mjs';
import { stubFolder, waitReady } from './m3-helpers.mjs';

/** 转发代理的端口（真实层 4880–4889） */
const PROXY_PORT = 4881;
/** 一次拉取的时限（列表请求 15 秒、最多 3 次，§11） */
const FETCH_MS = 90000;
/** “几百个模型”（MD-14 OpenRouter）的下限 */
const MANY = 200;
/** 驱动的名字（--only） */
const DRIVE_NAMES = ['deepseek', 'openrouter', 'glm', 'glm-pi', 'record'];
/** 带值的参数（给了参数却没有值时不跑） */
const VALUE_FLAGS = ['source', 'exe', 'only', 'deepseek', 'glm'];
/** 样本与回放 fixture 的目录 */
const FIXTURES = join(appRoot, 'tests/fixtures/discovery');
/** 列表错误后面的一句（§6.3） */
const STILL = 'You can still add model IDs below.';
/** Add a model ID 与已有的行重复时的错误（§6.4） */
const DUPLICATE = 'Model IDs must be unique within a provider.';
/** 写卡上回放录制的驱动（写下之后跑 md-replay.mjs） */
const CARD_DRIVES = ['deepseek', 'glm', 'glm-pi'];
/** md-replay.mjs 跑完的时限：几份录制，其中 OpenRouter 的清单有几百行 */
const REPLAY_MS = 20 * 60 * 1000;
/** 回放层的结果文件：md-replay.mjs 不带 --only 时写前一个，带 --only 时写后一个 */
const REPLAY_RESULTS = { all: join(appRoot, 'test-results/md-replay.json'),
  partial: join(appRoot, 'test-results/md-partial-replay.json') };
/** key 方式的 key 的环境变量（三个都要有值） */
const KEY_VARS = { deepseek: 'MD_REAL_DEEPSEEK_KEY', glm: 'MD_REAL_GLM_KEY', openrouter: 'MD_REAL_OPENROUTER_KEY' };
/**
 * key 方式的地址的环境变量与没给时的地址（共用的 KEY_MODE_URLS；OpenRouter 的地址固定为 OPENROUTER_BASE）。
 * 给了环境变量时用它的值，经 firstRunDeepSeek、addProviderUi 的 baseUrl 传进去。
 */
const URL_VARS = { deepseek: ['MD_REAL_DEEPSEEK_URL', KEY_MODE_URLS.deepseek],
  glm: ['MD_REAL_GLM_URL', KEY_MODE_URLS.glm] };
/** fixture 或样本里出现了 key 时的问题（写之前已换成 ***） */
const LEAKED = 'an API key typed into Mori appears in the recording (replaced by *** before writing)';

/** @brief 列表错误第一句的开头（§6.3，host 为提供商地址的主机）；no_list 没有 detail，整句就是它。 */
const listErrorLead = (kind, host) => ({ rejected: 'The server rejected the API key: ',
  unreachable: `Couldn’t reach ${host}: `, no_list: 'This server doesn’t list its models.',
  invalid: 'Couldn’t read the model list: ' })[kind];

/** @brief --name 的值；缺失或紧跟着另一个 --参数时为 null。 */
function argValue(name) {
  const value = arg(name);
  return value && !value.startsWith('--') ? value : null;
}

/**
 * @brief 读出 key 方式的环境变量，并立即从 process.env 删掉（之后启动的 Mori、md-replay.mjs 都拿不到）；key 只留在这个
 *        进程的内存里，不打印。
 * @return { keys: { deepseek, glm, openrouter }（没有值的为 null）, urls: { deepseek, glm } }
 */
function takeKeyEnv() {
  const take = (name) => {
    const value = process.env[name]?.trim() || null;
    delete process.env[name];
    return value;
  };
  const keys = Object.fromEntries(Object.entries(KEY_VARS).map(([id, name]) => [id, take(name)]));
  const urls = Object.fromEntries(Object.entries(URL_VARS).map(([id, [name, given]]) => [id, take(name) ?? given]));
  return { keys, urls };
}

const keyEnv = takeKeyEnv();
/** 这次运行知道的 key（key 方式的三个；--source 方式下为空） */
const secrets = Object.values(keyEnv.keys).filter(Boolean);
/** @brief 把文字里的 key 换成 ***（检查、日志与写出的文件都经它）。 */
const redact = redactor(secrets);
/** @brief 数据里有没有 key 的明文。 */
const leaked = (data) => redact(JSON.stringify(data)) !== JSON.stringify(data);
let source = argValue('source') ? resolve(argValue('source')) : null;
const exePath = argValue('exe') ? resolve(argValue('exe')) : null;
const only = argValue('only')?.split(',').filter(Boolean) ?? null;
const suffix = exePath ? '-packaged' : '';
const resultFile = only ? `md-partial-real${suffix}.json` : `md-real${suffix}.json`;
const shots = join(appRoot, `test-results/md-real${suffix}`);
const recorder = createRecorder(exePath ?? 'dev build');
/** @brief 记一条检查：名字与 detail 里的 key 换成 ***（key 方式下 Playwright 的报错可能带着输入框里填的值）。 */
const record = (name, ok, detail = '') => recorder.record(redact(name), ok, redact(detail));
const write = recorder.write;
const ctx = { app: null, page: null, pageErrors: [], logs: [], found: null, setupNotes: [], deepseekIds: null,
  glmOutcome: null, cardFixtures: [], keyMode: !source, dataDirs: [], shownKeys: [], projects: [], piProject: null };

/**
 * @brief 截图（失败也不报错）。截之前读窗口的文字（innerText，不含输入框的值）：出现 key 时不截（截图里会有 key），
 *        记下截图名，由 leakCheck 报出（§9：key 不回界面）。
 */
async function shot(name) {
  if (!ctx.page) return;
  const text = secrets.length ? await ctx.page.evaluate(() => document.body.innerText).catch(() => '') : '';
  if (secrets.some((secret) => text.includes(secret))) {
    ctx.shownKeys.push(name);
    return;
  }
  await ctx.page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});
}
/** @brief 按键排序后比较（配置、档案的对象与数组）。 */
const canon = (value) => (Array.isArray(value) ? value.map(canon) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canon(value[key])])) : value);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
/** @brief 勾选框的说法。 */
const onOff = (value) => (value ? 'on' : 'off');
/** @brief 配置里一个模型的字段（比较用）。 */
const modelOf = (row, family) => ({ id: row.id, family, contextWindow: Number(row.contextWindow),
  maxTokens: Number(row.maxTokens), reasoning: row.reasoning, input: row.image ? ['text', 'image'] : ['text'] });

// ---------- 启动与 fixture ----------

/**
 * @brief 启动 Mori：收集主进程与后台进程的输出，等 ready 的标识出现（侧栏，或全新数据目录的首次启动表单），装录制器。
 * @param ready 等它出现的 data-testid
 */
async function launchMori(userData, ready) {
  ctx.pageErrors = [];
  ctx.app = await launch({ exePath, userData });
  const child = ctx.app.process();
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk) => ctx.logs.push(...String(chunk).split(/\r?\n/).filter(Boolean)));
  }
  ctx.page = await ctx.app.firstWindow();
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  await ctx.page.waitForFunction(() => Boolean(window.mori), null, { timeout: 30000 });
  await ctx.page.getByTestId(ready).waitFor({ timeout: 60000 });
  await ctx.page.evaluate(installRecorder);
}

/** @brief 启动 Mori（已有配置的数据目录），打开设置 → Models。 */
async function startApp(userData) {
  await launchMori(userData, 'sidebar');
  await openModelsSettings(ctx.page);
}

/** @brief 关掉 Mori（有序关闭后台进程，最多等 20 秒；没关掉时结束主进程，不留进程）。 */
async function closeApp() {
  const app = ctx.app;
  ctx.app = null;
  if (app) {
    const closed = await Promise.race([app.close().then(() => true, () => true), sleep(20000).then(() => false)]);
    if (!closed) {
      console.error('[md-real] Mori did not close within 20 s; killing its main process');
      app.process().kill();
    }
  }
  ctx.page = null;
}

/**
 * @brief 写一份样本或 fixture：核对没有问题时写到 tests/fixtures/discovery/<relative>，有问题时写到
 *        test-results/md-real/<relative 的文件名>.rejected.json。写之前把 key 换成 ***（调用方先用 leaked 记下问题）。
 * @return 写到的路径
 */
function writeFixture(relative, data, problems) {
  const target = problems.length ? join(shots, `${relative.replace(/[\\/]/g, '-')}.rejected.json`)
    : join(FIXTURES, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, redact(`${JSON.stringify(data, null, 1)}\n`));
  return target;
}

/** @brief 开始录一份回放 fixture：开头的命令同 md-record.mjs（会话列表、设置，进入设置页时的 config.get 与 models.get）。 */
async function openFixture() {
  await recBegin(ctx.page);
  for (const command of OPENING) await recCmd(ctx.page, command);
}

/** @brief 录制器再发一次卡上的 models.discover（同一个命令：{ kind: 'provider', providerId }），返回结果。 */
const recordedDiscover = (provider) => recCmd(ctx.page, { type: 'models.discover',
  target: { kind: 'provider', providerId: provider.id } });

/** @brief fixture 的 notes：数据目录从哪来、测试准备，以及“key 没有离开 Mori”。 */
function fixtureNotes() {
  const origin = ctx.keyMode ? 'the data dir this run built through the UI (first run with DeepSeek, then Add provider '
    + 'for GLM and OpenRouter; the keys were typed into Mori\'s API key fields and saved encrypted by Mori)'
    : 'the owner\'s Mori data dir';
  return [`Setup (synthetic test setup, docs/specs/model-discovery.md §13.1): a copy of ${origin}, encrypted key files `
    + `only${ctx.setupNotes.length ? `; ${ctx.setupNotes.join('; ')}` : ''}`,
  'The card fetch used the key saved in Mori: the commands carry no key and the fixture stores no request headers'];
}

/**
 * @brief 停止录制，核对后写成回放 fixture ui/<name>.json（外层与步骤的格式同 md-record.mjs：source、note、name、
 *        description、covers、recorded、address、endpoint、model、notes、recordedAt、steps），记一条检查；写到
 *        fixtures 里时记下名字（之后由 replayCheck 回放）。
 * @param meta { provider, model（<provider>/<model>，回放桥的默认模型）, what（检查名里的说明）, description, covers }
 * @param problems 录制要的东西没有发生的地方（有时写到 test-results/md-real/…rejected.json）
 */
async function saveFixture(name, meta, problems) {
  const steps = await recEnd(ctx.page);
  const failed = [...problems, ...steps.filter((step) => step.result?.error)
    .map((step) => `${step.result.type}: ${step.result.error}`)];
  const fixture = { source: 'real', note: 'Recorded from the real App and the real server by tests/ui/md-real.mjs '
    + 'with the key saved in Mori; do not edit by hand.', name, description: meta.description,
  covers: meta.covers, recorded: localDate(), address: meta.provider.baseUrl, endpoint: meta.provider.baseUrl,
  model: meta.model, notes: fixtureNotes(), recordedAt: new Date().toISOString(), steps };
  if (leaked(fixture)) failed.push(LEAKED);
  const file = writeFixture(`ui/${name}.json`, fixture, failed);
  if (failed.length === 0) ctx.cardFixtures.push(name);
  record(`MD-14 real record: ${meta.what} is recorded as the replay fixture ui/${name}.json (§13.1; the format of `
    + 'md-record.mjs)', failed.length === 0, `${file} — ${steps.length} steps, `
    + `${steps.filter((step) => step.envelope).length} events — ${brief(failed)}`);
}

/** @brief 一个模型的档案（§7.2）：探针跑完、ready、记了完成时刻、有第 0 步的 reported；want 给出种类与报告值时比较。 */
function profileProblems(profile, probed, want = {}) {
  if (!probed) return [`the probes did not finish within ${PROBE_MS / 60000} minutes`];
  if (!profile) return ['no profile'];
  const problems = [];
  if (profile.status !== 'ready') problems.push(`status ${profile.status} (${profile.error})`);
  if (!profile.probedAt) problems.push('probedAt is null');
  if (want.kind && profile.server?.kind !== want.kind) problems.push(`server kind ${profile.server?.kind}`);
  if (profile.reported === null) problems.push('reported is null (step 0 wrote no meta)');
  else if (want.reported && !same(profile.reported, want.reported)) {
    problems.push(`reported ${JSON.stringify(profile.reported)}, want ${JSON.stringify(want.reported)}`);
  }
  return problems;
}

/** @brief 档案的摘要（detail 用）。 */
const profileBrief = (p) => (p ? { status: p.status, error: p.error, server: p.server, tool: p.tool_calling?.state,
  tier: p.tier?.level, context: p.context, reasoning: p.reasoning?.field, reported: p.reported } : null);

// ---------- deepseek ----------

/** @brief 一行与文档的一个模型不一致的地方。 */
function docProblems(row, doc) {
  return [
    row.contextWindow !== String(doc.contextWindow) ? `Context window ${row.contextWindow}` : null,
    row.maxTokens !== String(doc.maxTokens) ? `Max output ${row.maxTokens}` : null,
    row.defaults.length ? `Default on ${row.defaults.join(', ')}` : null,
    row.reasoning !== doc.reasoning ? `Supports thinking ${onOff(row.reasoning)}` : null,
    row.image !== doc.image ? `Image input ${onOff(row.image)}` : null,
  ].filter(Boolean);
}

/** @brief 文档列出的每个模型：服务列出了它，清单那一行的四个值与文档一致、两个数字都是报告值。 */
function docsChecks(rows) {
  for (const doc of DEEPSEEK_DOCS.models) {
    const row = rows.find((item) => item.id === doc.id);
    const problems = row ? docProblems(row, doc) : ['the server does not list it'];
    record(`MD-14 real DeepSeek: the checklist row of ${doc.id} matches the DeepSeek docs (${DEEPSEEK_DOCS.checked}, `
      + `${DEEPSEEK_DOCS.urls.join(', ')}): Context window ${doc.contextWindow} and Max output ${doc.maxTokens}, both `
      + `reported (no Default), Supports thinking ${onOff(doc.reasoning)}, Image input ${onOff(doc.image)}`,
    problems.length === 0, brief({ problems, row }));
  }
}

/** @brief 已在提供商里的模型（§6.5）：服务列出的标 Added、不能勾；没列出的写在 Not listed by the server 一行。 */
function addedChecks(rows, state, provider, configured) {
  const notListed = (state.notListed ?? '').replace(/^Not listed by the server: /, '').split(', ').filter(Boolean);
  const problems = [];
  for (const id of configured) {
    const row = rows.find((item) => item.id === id);
    if (row && (!row.added || row.pickable || !row.tags.includes('added'))) problems.push(`${id}: ${brief(row, 300)}`);
    if (!row && !notListed.includes(id)) problems.push(`${id} is neither listed nor in Not listed by the server`);
  }
  for (const row of rows.filter((item) => item.added && !configured.includes(item.id))) {
    problems.push(`${row.id} is marked Added but is not in ${provider.id}`);
  }
  record(`MD-14 real DeepSeek: the models already in ${provider.id} (${configured.join(', ')}) are marked Added and `
    + 'can\'t be ticked when the server lists them, and the others are named in "Not listed by the server"',
  problems.length === 0, brief({ problems, notListed: state.notListed }));
}

/** @brief 录下的 DeepSeek 清单（fixture）：没有错误和列表错误、种类 deepseek、id 与界面的行相同。 */
function deepseekResultProblems(result, rows) {
  const problems = [];
  if (result.error !== null || result.cancelled || result.listError) {
    problems.push(`error ${result.error}, cancelled ${result.cancelled}, listError ${brief(result.listError)}`);
  }
  if (result.server?.kind !== 'deepseek') problems.push(`server ${brief(result.server)}`);
  if (!same(result.models.map((model) => model.id), rows.map((row) => row.id))) {
    problems.push('the recorded models differ from the rows the card showed');
  }
  return problems;
}

/**
 * @brief 只勾文档的一个模型，把它的 Context window 改小：Max output 按 §4.3 跟着变（报告的输出上限小于新窗口时用它，
 *        否则为 16384 与新窗口一半中较小的并标 Default），窗口仍是报告值，按钮“Add 1 model”。
 * @return 加入时这一行的值
 */
async function lowerAndPick(card, doc) {
  await pickOnly(card, doc.id);
  const before = (await readRows(card)).find((row) => row.id === doc.id);
  const lowered = Math.min(65536, Math.floor(Number(before.contextWindow) / 2));
  await rowOf(card, doc.id).locator('input[data-field="contextWindow"]').fill(String(lowered));
  const rows = await readRows(card);
  const row = rows.find((item) => item.id === doc.id);
  const reported = before.defaults.includes('maxTokens') ? null : Number(before.maxTokens);
  const keep = reported !== null && reported < lowered;
  const wantMax = keep ? reported : unreportedMax(lowered);
  const picked = rows.filter((item) => item.picked).map((item) => item.id);
  const { add } = await fetchedState(card);
  record(`MD-14 real DeepSeek: after Clear selection, ticking ${doc.id} and lowering its Context window to ${lowered}, `
    + `Max output follows §4.3 (${wantMax}${keep ? '' : ', Default'}), the window stays reported, only it is `
    + 'ticked and the button reads "Add 1 model"', row.contextWindow === String(lowered)
    && row.maxTokens === String(wantMax) && same(row.defaults, keep ? [] : ['maxTokens']) && same(picked, [doc.id])
    && add?.text === 'Add 1 model' && !add.disabled, brief({ row, picked, add }));
  return { ...row, lowered };
}

/**
 * @brief Add 1 model → 配置里加在最后的正是这一个模型、值同清单那一行；探针跑完（第 0 步读到 kind deepseek 与文档的值）；
 *        模型行的提示。录制里记一步界面发的 models.addModels（{ note, command }，录制器录不到界面自己的命令；命令按界面的
 *        操作写出，接着核对配置里加在最后的模型与它相同，不同时 fixture 写到 rejected），再像界面一样读 models.get；
 *        探针跑完后像重新进入设置页一样读 config.get 与 models.get。
 * @param added { provider, doc, row（lowerAndPick 的结果）, family, configured（加入之前提供商里的模型 id） }
 * @return 回放 fixture 要的东西没有发生的地方
 */
async function addDeepSeek(card, { provider, doc, row, family, configured }) {
  const ref = `${provider.id}/${doc.id}`;
  const since = Date.now() - 1000;
  await card.locator('[data-action="add-models"]').click();
  await waitModelRow(card, ref);
  await card.getByTestId('checklist').waitFor({ state: 'detached', timeout: 15000 });
  const want = modelOf({ ...row, contextWindow: row.lowered }, family);
  await recUiCommand(ctx.page, { type: 'models.addModels', providerId: provider.id, models: [want] },
    `UI: on the ${provider.id} card checklist only ${doc.id} was ticked and its Context window lowered to `
    + `${row.lowered}; Add 1 model sent this command (sent by the UI: window.mori is frozen, so this recorder cannot `
    + 'log it; checked against the models appended to the config)');
  const appended = (await recCmd(ctx.page, { type: 'models.get' })).config.providers
    .find((item) => item.id === provider.id).models.slice(configured.length);
  const saved = same(appended, [want]);
  record(`MD-14 real DeepSeek: Add 1 model appends exactly ${ref} to ${provider.id} with the checklist row's values `
    + `(${brief(want, 300)}) and closes the checklist`, saved, brief(appended));
  const probed = await waitProbed(ctx.page, ref, since, PROBE_MS);
  await shot('deepseek-probed');
  await recCmd(ctx.page, { type: 'config.get' });
  const profile = (await recCmd(ctx.page, { type: 'models.get' })).profiles[ref];
  const reported = { contextWindow: doc.contextWindow, maxTokens: doc.maxTokens, reasoning: doc.reasoning,
    image: doc.image };
  const problems = profileProblems(profile, probed, { kind: 'deepseek', reported });
  record(`MD-14 real DeepSeek: the probes of ${ref} complete (status ready) and step 0 reads the server through the `
    + `reader: kind deepseek, reported ${brief(reported, 200)} as in the docs`, problems.length === 0,
  brief({ problems, profile: profileBrief(profile) }));
  // 界面收到同一个 mori.profiles 之后才重画模型行：等它不再是 Verifying… 且有了提示（最多 10 秒），再核对
  const settled = (row) => !['verifying', 'reverifying', null].includes(row.tool) && row.hints.length > 0;
  const state = await pollFor(() => modelRowState(modelRowOf(card, ref)), settled, 10000);
  const text = `Server reports a context window of ${thousands(doc.contextWindow)}.`;
  record(`MD-14 real DeepSeek: after the probes the model row of ${ref} shows one hint "${text}" with Use (its window `
    + 'was lowered in the checklist) and no "(default)"', !['verifying', 'reverifying', null].includes(state.tool)
    && same(state.hints, [{ kind: 'context', text }]) && state.defaults.length === 0, brief(state));
  return [...(saved ? [] : [`the models appended to ${provider.id} are ${brief(appended, 300)}`]), ...problems];
}

/** @brief DeepSeek 的回放 fixture 的说明（saveFixture 的 meta）。 */
const deepseekMeta = (provider, configured, doc) => ({ provider, model: `${provider.id}/${configured[0]}`,
  covers: ['MD-07', 'MD-13'],
  what: `the ${provider.id} card checklist (models.discover with the saved key), the add of `
    + `${doc?.id ?? 'a documented model'} with a lowered window and Settings after its probes`,
  description: `Settings → Models: Fetch models on the ${provider.id} card with the saved key (real DeepSeek list); `
    + `tick only ${doc?.id ?? 'a documented model'}, lower its Context window, Add 1 model; after its probes reopen `
    + 'Settings (models.get and mori.profiles with reported: the model row hints "Server reports a context window")' });

/** @brief deepseek：卡上 Fetch models、文档核对、勾一个改小窗口、加入、探针；全程录成回放 fixture md-deepseek-card。 */
async function deepseekDrive() {
  const provider = ctx.found.deepseek;
  const card = cardOf(ctx.page, provider.id);
  await card.scrollIntoViewIfNeeded();
  const configured = (await modelsGet(ctx.page)).config.providers.find((item) => item.id === provider.id).models
    .map((model) => model.id);
  await openFixture();
  await card.locator('[data-action="fetch-models"]').click();
  const state = await waitFetched(card, FETCH_MS);
  const rows = await readRows(card);
  ctx.deepseekIds = rows.map((row) => row.id);
  await shot('deepseek-checklist');
  record('MD-14 real DeepSeek: Fetch models on the card (with the saved key) opens the checklist in the card with the '
    + 'server\'s models, without a Detected line, and the card\'s Fetch models is disabled while it is open',
  state.checklist && !state.listError && state.commandError === null && rows.length > 0 && state.detected === null
    && state.fetch.length === 1 && state.fetch[0].disabled, brief({ state, ids: ctx.deepseekIds,
    log: ctx.logs.filter((line) => line.includes('discover ')).slice(-3) }));
  docsChecks(rows);
  addedChecks(rows, state, provider, configured);
  const result = await recordedDiscover(provider);
  const problems = deepseekResultProblems(result, rows);
  const doc = DEEPSEEK_DOCS.models.find((item) => rows.some((row) => row.id === item.id && row.pickable)) ?? null;
  if (!doc) {
    record('MD-14 real DeepSeek: a model of the docs that the server lists can be ticked', false, brief(rows));
    await saveFixture('md-deepseek-card', deepseekMeta(provider, configured, doc),
      [...problems, 'no documented model could be added']);
    return;
  }
  const row = await lowerAndPick(card, doc);
  const family = result.models.find((model) => model.id === doc.id)?.family ?? '';
  const added = await addDeepSeek(card, { provider, doc, row, family, configured });
  await saveFixture('md-deepseek-card', deepseekMeta(provider, configured, doc), [...problems, ...added]);
}

// ---------- openrouter ----------

/** @brief Add provider 拉取之后（§6.1）：Detected: OpenRouter、Name 与 API type 预填、Base URL 不换。 */
async function addFormChecks(form, state) {
  const value = (label) => form.getByLabel(label, { exact: true }).inputValue();
  const got = { detected: state.detected, name: await value('Name'), api: await value('API type'),
    baseUrl: await value('Base URL'), note: state.baseUrlNote };
  record('MD-14 real OpenRouter: Add provider shows "Detected: OpenRouter" and prefills Name openrouter.ai and API '
    + `type OpenAI-compatible; the Base URL stays ${OPENROUTER_BASE} with no "Updated to" line`,
  got.detected?.kind === 'openrouter' && got.detected.text === 'Detected: OpenRouter' && got.name === 'openrouter.ai'
    && got.api === 'openai-completions' && got.baseUrl === OPENROUTER_BASE && got.note === null, brief(got));
}

/**
 * @brief 过滤（§6.2）：要加入的是第一个还没加入的免费、有工具支持的模型（freeToolRow：有 OpenRouter 的 key 时加入后的
 *        探针不花钱，也能通过）；按它的厂商前缀（id 里 "/" 前面的一段）的大写过滤，显示的正好是 id 含它（不分大小写）的
 *        行；勾上它、清空过滤后只有它勾着。
 * @return 勾上的那一行；没有这样的行时为 null
 */
async function filterAndPick(scope, rows, count) {
  await scope.locator('[data-action="clear-selection"]').click();
  const target = freeToolRow(rows);
  if (!target) {
    record('MD-14 real OpenRouter: the list has a free model (id ending ":free") with tool support (no "The server '
      + 'doesn’t list tool support" hint) that is not added yet and can be ticked', false,
    brief(rows.filter((row) => row.id.endsWith(':free')).slice(0, 10)));
    return null;
  }
  const vendor = target.id.split('/')[0];
  const filter = scope.getByTestId('checklist-filter');
  await filter.fill(vendor.toUpperCase());
  const shown = (await readRows(scope)).map((row) => row.id);
  const want = rows.map((row) => row.id).filter((id) => id.toLowerCase().includes(vendor.toLowerCase()));
  const { title } = await fetchedState(scope);
  record(`MD-14 real OpenRouter: typing "${vendor.toUpperCase()}" in Filter models shows exactly the rows whose id `
    + `contains it, ignoring case (${want.length} of ${count}), and the title stays "Models (${count})"`,
  same(shown, want) && want.length < count && title === `Models (${count})`, brief({ shown: shown.length,
    want: want.length, title }));
  await rowOf(scope, target.id).locator('input[name="pick"]').check();
  await filter.fill('');
  const all = await readRows(scope);
  const picked = all.filter((row) => row.picked).map((row) => row.id);
  const { add } = await fetchedState(scope);
  record(`MD-14 real OpenRouter: ticking ${target.id} while filtered and clearing the filter shows all ${count} rows `
    + 'again with only it ticked, and the button reads "Add 1 model"', same(picked, [target.id]) && all.length === count
    && add?.text === 'Add 1 model' && !add.disabled, brief({ picked, rows: all.length, add }));
  return all.find((row) => row.id === target.id);
}

/** @brief Add 1 model：配置里有它（Add provider 时是新的提供商 openrouter.ai，没有 key）。 */
async function openrouterAdd(scope, existing, before, row) {
  await scope.locator('[data-action="add-models"]').click();
  let providerId = existing?.id ?? null;
  if (existing) await waitModelRow(scope, `${existing.id}/${row.id}`);
  else {
    await scope.waitFor({ state: 'detached', timeout: 30000 });
    const after = await pollFor(() => cardIds(ctx.page), (ids) => ids.length > before.length, 15000);
    providerId = after.find((id) => !before.includes(id)) ?? null;
  }
  const provider = (await modelsGet(ctx.page)).config.providers.find((item) => item.id === providerId);
  const saved = provider?.models.at(-1);
  const problems = [];
  // OpenRouter 的行没有 §4.1 的 family 路径（details.family、model_family），按 family 原样保存就是空字符串
  if (!saved || !same(saved, modelOf(row, ''))) problems.push(`model ${brief(saved, 300)}`);
  if (!existing && (provider?.baseUrl !== OPENROUTER_BASE || provider.api !== 'openai-completions'
    || provider.name !== 'openrouter.ai' || provider.keys.length !== 0 || provider.models.length !== 1)) {
    problems.push(`provider ${brief({ ...provider, models: provider?.models.length }, 400)}`);
  }
  const shown = providerId ? await modelRowOf(cardOf(ctx.page, providerId), `${providerId}/${row.id}`).count() : 0;
  if (shown !== 1) problems.push('no model row on the card');
  record(`MD-14 real OpenRouter: Add 1 model saves ${row.id} with the checklist row's values${existing ? ` at the end `
    + `of ${existing.id}` : ` in a new provider openrouter.ai (${OPENROUTER_BASE}, OpenAI-compatible, no key)`} and `
    + 'its row is on the card', problems.length === 0, brief({ problems, providerId }));
}

/** @brief openrouter：Add provider（或已有提供商的卡）拉取、几百行、过滤、只勾一个、加入。 */
async function openrouterDrive() {
  const existing = ctx.found.openrouter;
  const before = await cardIds(ctx.page);
  const scope = existing ? cardOf(ctx.page, existing.id) : ctx.page.getByTestId('provider-form');
  if (existing) {
    await scope.scrollIntoViewIfNeeded();
    await scope.locator('[data-action="fetch-models"]').click();
  } else {
    await ctx.page.locator('[data-action="add-provider"]').click();
    await scope.getByLabel('Base URL', { exact: true }).fill(OPENROUTER_BASE);
    await scope.locator('[data-action="fetch-models"]').click();
  }
  const state = await waitFetched(scope, FETCH_MS);
  const rows = await readRows(scope);
  await shot('openrouter-checklist');
  const count = Number(/^Models \((\d+)\)$/.exec(state.title ?? '')?.[1]);
  record(`MD-14 real OpenRouter: Fetch models (${existing ? `the card of ${existing.id}` : `Add provider with `
    + `${OPENROUTER_BASE} and no key`}) lists hundreds of models: "Models (N)" with N ≥ ${MANY}, one row per model, `
    + 'and the Filter models box', state.checklist && !state.listError && count >= MANY && rows.length === count
    && state.filter, brief({ title: state.title, rows: rows.length, listError: state.listError,
    commandError: state.commandError, filter: state.filter }));
  if (!existing) await addFormChecks(scope, state);
  const row = await filterAndPick(scope, rows, count);
  if (row) await openrouterAdd(scope, existing, before, row);
}

// ---------- glm ----------

/**
 * @brief 列表错误的两句（§6.3）：第一句是这个种类的写法（no_list 整句固定，其余开头固定、后面是不为空的 detail），
 *        后面一句“You can still add model IDs below.”；没有清单的标题（Models (N)）。
 */
function listErrorProblems(state, host) {
  const { kind, text } = state.listError;
  const lead = listErrorLead(kind, host);
  if (lead === undefined) return [`unknown list error kind ${kind}`];
  const detail = text.startsWith(lead) && text.endsWith(STILL) ? text.slice(lead.length, -STILL.length) : null;
  const ok = kind === 'no_list' ? detail === '' : Boolean(detail?.trim());
  return [...(ok ? [] : [`list error text "${text}"`]),
    ...(state.checklist || state.title !== null ? [`a checklist title ${state.title} next to the list error`] : [])];
}

/** @brief GLM 拉取之后的样子：清单（标题的 N 等于行数）或列表错误（listErrorProblems）。 */
function glmOutcomeProblems(state, rows, host) {
  if (state.commandError !== null) return [`command error: ${state.commandError}`];
  if (state.cancelled) return ['the fetch was cancelled'];
  if (state.listError) return listErrorProblems(state, host);
  const count = Number(/^Models \((\d+)\)$/.exec(state.title ?? '')?.[1]);
  return state.checklist && count === rows.length ? [] : [`title ${state.title} with ${rows.length} rows`];
}

/** @brief 录下的 GLM 结果（fixture）：命令没有失败，列表错误的种类（或列表的 id）与界面显示的相同。 */
function glmResultProblems(result, state, rows) {
  const problems = [];
  if (result.error !== null || result.cancelled) problems.push(`error ${result.error}, cancelled ${result.cancelled}`);
  if ((result.listError?.kind ?? null) !== (state.listError?.kind ?? null)) {
    problems.push(`listError ${brief(result.listError)} while the card showed ${brief(state.listError)}`);
  }
  if (!result.listError && !same(result.models.map((model) => model.id), rows.map((row) => row.id))) {
    problems.push('the recorded models differ from the rows the card showed');
  }
  return problems;
}

/**
 * @brief GLM-5.3 那一行（手填或服务列出的）：只有它勾着、按钮 Add 1 model。服务列出了它时，在 Add a model ID 里手填它
 *        得到重复的错误、Add to list 不可用（§6.4）；手填的行在列表错误下面（§6.3）或在清单末尾（§6.4），标 Entered by
 *        you、默认值且标 Default、思考与图片不勾。
 * @param seen { row, listed, picked, add, typed（服务列出时手填之后的 manualState）, placed（行的位置对） }
 */
function glmRowProblems({ row, listed, picked, add, typed, placed }) {
  if (!row) return ['no row'];
  const problems = [];
  if (!same(picked, [GLM_MANUAL_ID])) problems.push(`ticked: ${picked.join(', ') || 'none'}`);
  if (add?.text !== 'Add 1 model' || add.disabled) problems.push(`button ${brief(add)}`);
  if (listed) {
    if (typed.error !== DUPLICATE || typed.blocked !== true) problems.push(`typing it: ${brief(typed)}`);
    return problems;
  }
  if (!placed) problems.push('the row is not under the list error / at the end of the checklist');
  if (!same(row.tags, ['entered'])) problems.push(`tags ${row.tags.join(', ')}`);
  if (row.contextWindow !== String(UNREPORTED_WINDOW) || row.maxTokens !== String(unreportedMax(UNREPORTED_WINDOW))) {
    problems.push(`values ${row.contextWindow} / ${row.maxTokens}`);
  }
  if (!same([...row.defaults].sort(), ['contextWindow', 'maxTokens'])) {
    problems.push(`Default ${row.defaults}`);
  }
  if (row.reasoning || row.image) problems.push('Supports thinking or Image input is on');
  return problems;
}

/**
 * @brief 服务列出了 GLM-5.3 时（§6.4）：先在 Add a model ID 里手填它（与清单的行重复，读下这时的样子），清空输入框，
 *        再勾那一行。
 * @return 手填之后的 manualState
 */
async function pickListed(card) {
  const input = card.getByTestId('manual-model').locator('input[data-field="id"]');
  await input.fill(GLM_MANUAL_ID);
  const typed = await manualState(card);
  await input.fill('');
  await rowOf(card, GLM_MANUAL_ID).locator('input[name="pick"]').check();
  return typed;
}

/** @brief 手填的行的位置：列表错误时在错误下面（§6.3），有清单时在清单末尾（§6.4）。 */
const manualPlaced = async (card, state, rows) => (state.listError
  ? rowsFollow(card, '[data-testid="list-error"]') : rows.at(-1)?.id === GLM_MANUAL_ID);

/** @brief GLM-5.3：手填（服务列出了它时勾那一行）、只勾它、加入、探针跑完。 */
async function glmAdd(card, provider, state, rows, result) {
  const ref = `${provider.id}/${GLM_MANUAL_ID}`;
  const listed = rows.find((row) => row.id === GLM_MANUAL_ID) ?? null;
  if (state.checklist) await card.locator('[data-action="clear-selection"]').click();
  const typed = listed ? await pickListed(card) : null;
  if (!listed) await addModelId(card, GLM_MANUAL_ID);
  const after = await readRows(card);
  const row = after.find((item) => item.id === GLM_MANUAL_ID);
  const { add } = await fetchedState(card);
  const picked = after.filter((item) => item.picked).map((item) => item.id);
  const placed = await manualPlaced(card, state, after);
  const problems = glmRowProblems({ row, listed, picked, add, typed, placed });
  record(listed ? `MD-14 real GLM: the server lists ${GLM_MANUAL_ID}, so typing it in Add a model ID shows `
    + `"${DUPLICATE}" with Add to list disabled and its row is ticked instead; only it is ticked and the button reads `
    + '"Add 1 model"'
    : `MD-14 real GLM: Add a model ID ${GLM_MANUAL_ID} adds a ticked row marked Entered by you `
      + `${state.listError ? 'under the list error' : 'at the end of the checklist'}, Context window `
      + `${UNREPORTED_WINDOW} and Max output ${unreportedMax(UNREPORTED_WINDOW)} both marked Default, thinking and `
      + 'image off; only it is ticked and the button reads "Add 1 model"', problems.length === 0,
  brief({ problems, row, picked, add, typed, placed }));
  if (!row) return;
  const since = Date.now() - 1000;
  await card.locator('[data-action="add-models"]').click();
  await waitModelRow(card, ref);
  const saved = (await modelsGet(ctx.page)).config.providers.find((item) => item.id === provider.id).models.at(-1);
  const family = listed ? result.models.find((model) => model.id === GLM_MANUAL_ID)?.family ?? '' : '';
  record(`MD-14 real GLM: Add 1 model saves ${ref} at the end of ${provider.id} with the row's values`,
    same(saved, modelOf(row, family)), brief(saved));
  const probed = await waitProbed(ctx.page, ref, since, PROBE_MS);
  await shot('glm-probed');
  const profile = (await modelsGet(ctx.page)).profiles[ref];
  const failed = profileProblems(profile, probed);
  record(`MD-14 real GLM: the probes of ${ref} complete (status ready) and its profile has what step 0 read through `
    + 'the reader (reported is not null)', failed.length === 0,
  brief({ problems: failed, profile: profileBrief(profile) }));
}

/** @brief glm：卡上 Fetch models → 清单或列表错误（录成回放 fixture md-glm-card）→ GLM-5.3 加入与探针。 */
async function glmDrive() {
  const provider = ctx.found.glm;
  const card = cardOf(ctx.page, provider.id);
  await card.scrollIntoViewIfNeeded();
  const first = (await modelsGet(ctx.page)).config.providers.find((item) => item.id === provider.id).models[0].id;
  await openFixture();
  await card.locator('[data-action="fetch-models"]').click();
  const state = await waitFetched(card, FETCH_MS);
  const rows = await readRows(card);
  ctx.glmOutcome = state.listError?.kind ?? (state.checklist ? 'list' : null);
  await shot('glm-fetched');
  const problems = glmOutcomeProblems(state, rows, new URL(provider.baseUrl).host);
  record('MD-14 real GLM: Fetch models on the card (with the saved key) shows either the model list ("Models (N)" '
    + 'with N rows) or a list error with its §6.3 text (and its detail) followed by "You can still add model IDs '
    + 'below." and no checklist title',
  problems.length === 0, brief({ problems, outcome: ctx.glmOutcome, listError: state.listError, title: state.title,
    ids: rows.map((row) => row.id).slice(0, 40) }));
  const result = await recordedDiscover(provider);
  const shown = state.listError ? `the list error ${state.listError.kind}` : `the model list (${rows.length} models)`;
  await saveFixture('md-glm-card', { provider, model: `${provider.id}/${first}`, covers: ['MD-07', 'MD-13'],
    what: `the ${provider.id} card's models.discover with the saved key (${shown})`,
    description: `Settings → Models: Fetch models on the ${provider.id} card with the saved key (${provider.baseUrl}); `
      + `the card showed ${shown}` }, glmResultProblems(result, state, rows));
  await glmAdd(card, provider, state, rows, result);
}

// ---------- glm-pi：取自 pi 模型表的值（MD-17，2026-10-26，WP-15，规格 §4.4、§6.2、§8） ----------

/** 加入时 Max output 设成 Mori 默认值、窗口与思考用 pi 的模型（z.ai 的列表与 pi 的 Z.AI 条目里都有）；会话的一轮用它 */
const PI_PICK = 'glm-5.3-flash';
/** 加入时设回 Mori 默认值的模型（像 2026-10-26 以前加入的）：§8 表后三行的提示从它的行上出 */
const PI_HINTED = 'glm-5.2';
/** PI_HINTED 在清单里设的 Max output：你设的值（不是默认值、不等于 pi 的），之后不提示改成 pi 的 */
const PI_OWN_MAX = 8192;
/** §8 表后三行（pi 的提示）的 data-kind */
const PI_HINT_KINDS = ['pi-context', 'pi-max-output', 'pi-reasoning'];
/** 会话的一轮发的话（不调用工具，回复很短） */
const PI_TURN = 'Reply with the single word OK. Do not call any tools.';
/** 一轮的时限 */
const TURN_MS = 5 * 60 * 1000;
/** @brief 清单里"From pi"的悬停说明（§6.2）。 */
const piListTitle = (provider) => `The server didn’t report this, so Mori used pi’s model list for ${provider}. `
  + 'Change it if you know the real value.';
/** @brief 模型行里"(from pi)"的悬停说明（§8；2026-10-26 审查后改为只说与 pi 的值相同）。 */
const piRowTitle = (provider) => `The server didn’t report this; pi’s model list for ${provider} has the same value. `
  + 'Use Edit to set the real value.';

/**
 * @brief 清单的一行按 pi 的模型表该显示的（§4.4、§6.2，独立实现：条目由测试从 pi-ai 读）：服务报告了的项照录下的结果；
 *        没报告的窗口、思考取 pi 的（思考只在 pi 说支持时），最大输出取 pi 的（小于这一行的窗口时），都标 From pi；
 *        再没有的为默认值，仍是默认值的数字标 Default。Image input 从不取 pi 的（服务没报告时不勾，2026-10-26 审查后补）。
 * @param model 录下的结果里这一行（只用 id、reported 与服务报告的值）
 * @param entry piEntriesAt 里这个 id 的条目；没有时为 null
 */
function piRowWant(model, entry) {
  const r = model.reported;
  const window = r.contextWindow ? model.contextWindow : entry?.contextWindow ?? UNREPORTED_WINDOW;
  const serverMax = r.maxTokens ? model.maxTokens : null;
  const piMax = serverMax === null && entry && entry.maxTokens < window ? entry.maxTokens : null;
  const max = serverMax ?? piMax ?? unreportedMax(window);
  const piWindow = !r.contextWindow && entry !== null;
  const piThinking = !r.reasoning && entry?.reasoning === true;
  return { id: model.id, contextWindow: String(window), maxTokens: String(max),
    reasoning: r.reasoning ? model.reasoning : piThinking, image: r.image ? model.image : false,
    pi: [...(piWindow ? ['contextWindow'] : []), ...(piMax !== null ? ['maxTokens'] : []),
      ...(piThinking ? ['reasoning'] : [])],
    defaults: [...(!r.contextWindow && !piWindow && window === UNREPORTED_WINDOW ? ['contextWindow'] : []),
      ...(serverMax === null && piMax === null ? ['maxTokens'] : [])],
    title: entry ? piListTitle(entry.provider) : null };
}

/** @brief 清单的一行与 piRowWant 不同的地方。 */
function piRowProblems(row, want) {
  if (!row) return [`${want.id}: no row`];
  const got = { contextWindow: row.contextWindow, maxTokens: row.maxTokens, reasoning: row.reasoning,
    image: row.image, pi: [...row.pi].sort(), defaults: [...row.defaults].sort() };
  const expected = { contextWindow: want.contextWindow, maxTokens: want.maxTokens, reasoning: want.reasoning,
    image: want.image, pi: [...want.pi].sort(), defaults: [...want.defaults].sort() };
  const titles = row.piTitles.every((title) => title === want.title);
  return same(got, expected) && titles ? [] : [`${want.id}: ${brief({ got, expected, titles: row.piTitles }, 400)}`];
}

/**
 * @brief 要加入的两行（都能勾、pi 有条目）：flash 为 PI_PICK（没有时最后一个），hinted 为 PI_HINTED（没有时另一个）。
 * @return { flash, hinted }；不够两行时缺的为 null
 */
function piPicks(rows, entries) {
  const usable = rows.filter((row) => row.pickable && !row.added && entries.has(row.id));
  const flash = usable.find((row) => row.id === PI_PICK) ?? usable.at(-1) ?? null;
  const others = usable.filter((row) => row !== flash);
  return { flash, hinted: others.find((row) => row.id === PI_HINTED) ?? others[0] ?? null };
}

/**
 * @brief 手填的行不查 pi 的模型表（§6.4）：Add a model ID 填 pi 的模型表里这个地址有、z.ai 的列表里没有的第一个 id
 *        （按 pi 列出的顺序），这一行写 Default、不写 From pi。之后的 Clear selection 把它取消勾选，不加入（z.ai 没有它）。
 */
async function piManualRow(card, { entries, rows, origin }) {
  const id = [...entries.keys()].find((key) => !rows.some((row) => row.id === key)) ?? null;
  if (id) await addModelId(card, id);
  const row = id ? (await readRows(card)).find((item) => item.id === id) : null;
  record(`MD-17 real GLM: Add a model ID ${id ?? '(none)'} (pi's model list has it for ${origin}; the server doesn't `
    + `list it) adds a ticked row marked Entered by you with Context window ${UNREPORTED_WINDOW} and Max output `
    + `${unreportedMax(UNREPORTED_WINDOW)} both "Default", no "From pi" and thinking off (typed rows don't look up `
    + 'pi\'s model list)', Boolean(row) && row.picked && same(row.tags, ['entered'])
    && row.contextWindow === String(UNREPORTED_WINDOW) && row.maxTokens === String(unreportedMax(UNREPORTED_WINDOW))
    && same([...row.defaults].sort(), ['contextWindow', 'maxTokens']) && row.pi.length === 0 && !row.reasoning,
  brief({ id, row }));
}

/**
 * @brief 清单里改两行（§6.2）：flash 的 Max output 改成按它的窗口算的默认值（加入后模型行有 pi 的输出上限提示）；
 *        hinted 的窗口改回 128000（Max output 随之为默认值）、Max output 改成 PI_OWN_MAX、不勾 Supports thinking。
 *        只勾这两行。
 */
async function piPrepare(card, { flash, hinted }) {
  await pickOnly(card, flash.id);
  await rowOf(card, hinted.id).locator('input[name="pick"]').check();
  const flashRow = rowOf(card, flash.id);
  await flashRow.locator('input[data-field="maxTokens"]').fill(String(unreportedMax(Number(flash.contextWindow))));
  const hintedRow = rowOf(card, hinted.id);
  await hintedRow.locator('input[data-field="contextWindow"]').fill(String(UNREPORTED_WINDOW));
  await hintedRow.locator('input[data-field="maxTokens"]').fill(String(PI_OWN_MAX));
  await hintedRow.locator('input[data-field="reasoning"]').setChecked(false);
}

/**
 * @brief Add 2 models：配置里加在最后的正是这两行（清单顺序）、值同清单；录制里记一步界面发的 models.addModels（同
 *        addDeepSeek 的写法），再像界面一样读 models.get。
 * @return 加入的模型（配置里的写法，按清单顺序）；没有加对时为 null
 */
async function piAdd(card, { provider, ids, result, configured }) {
  const rows = (await readRows(card)).filter((item) => ids.includes(item.id));
  const family = (id) => result.models.find((model) => model.id === id)?.family ?? '';
  const want = rows.map((row) => modelOf(row, family(row.id)));
  await card.locator('[data-action="add-models"]').click();
  for (const id of ids) await waitModelRow(card, `${provider.id}/${id}`);
  await card.getByTestId('checklist').waitFor({ state: 'detached', timeout: 15000 });
  await recUiCommand(ctx.page, { type: 'models.addModels', providerId: provider.id, models: want },
    `UI: on the ${provider.id} card checklist only ${ids.join(' and ')} were ticked (${ids[0]} with Max output set to `
    + `the default, ${ids[1]} set back to the defaults with Max output ${PI_OWN_MAX} and thinking off); Add 2 models `
    + 'sent this command (sent by the UI: window.mori is frozen, so this recorder cannot log it; checked against the '
    + 'models appended to the config)');
  const appended = (await recCmd(ctx.page, { type: 'models.get' })).config.providers
    .find((item) => item.id === provider.id).models.slice(configured.length);
  record(`MD-17 real GLM: Add 2 models appends exactly ${ids.join(' and ')} to ${provider.id} with the checklist's `
    + `values (${brief(want, 400)})`, same(appended, want), brief(appended));
  return same(appended, want) ? want : null;
}

/**
 * @brief 模型行按 pi 的条目该显示的（§8，独立实现；z.ai 什么都不报告，档案的 catalog 就是条目的三项，最大输出小于
 *        条目的窗口时才有）：说明的开头（"(from pi)" 先于 "(default)"）、标 "(from pi)" 的项、标 "(default)" 的项、
 *        §8 表后三行的提示（kind、文字、Use 保存的模型），按表的顺序。
 */
function piRowExpect(model, entry) {
  const max = entry.maxTokens < entry.contextWindow ? entry.maxTokens : null;
  const pi = [...(model.contextWindow === entry.contextWindow ? ['contextWindow'] : []),
    ...(max !== null && model.maxTokens === max ? ['maxTokens'] : []),
    ...(entry.reasoning && model.reasoning ? ['reasoning'] : [])];
  const defaults = [...(!pi.includes('contextWindow') && model.contextWindow === UNREPORTED_WINDOW
    ? ['contextWindow'] : []),
  ...(!pi.includes('maxTokens') && model.maxTokens === unreportedMax(model.contextWindow) ? ['maxTokens'] : [])];
  const mark = (field) => (pi.includes(field) ? ' (from pi)' : defaults.includes(field) ? ' (default)' : '');
  const meta = `Context window: ${thousands(model.contextWindow)}${mark('contextWindow')} · Max output: `
    + `${thousands(model.maxTokens)}${mark('maxTokens')}`;
  const lead = `pi’s model list for ${entry.provider}`;
  const hints = [];
  if (entry.contextWindow !== model.contextWindow && model.contextWindow === UNREPORTED_WINDOW) {
    const maxTokens = model.maxTokens >= entry.contextWindow ? unreportedMax(entry.contextWindow) : model.maxTokens;
    hints.push({ kind: 'pi-context', text: `${lead} has a context window of ${thousands(entry.contextWindow)}.`,
      model: { ...model, contextWindow: entry.contextWindow, maxTokens } });
  }
  if (max !== null && max !== model.maxTokens && max < model.contextWindow
    && model.maxTokens === unreportedMax(model.contextWindow)) {
    hints.push({ kind: 'pi-max-output', text: `${lead} has max output of ${thousands(max)}.`,
      model: { ...model, maxTokens: max } });
  }
  if (entry.reasoning && !model.reasoning) {
    hints.push({ kind: 'pi-reasoning', text: `${lead} says this model supports thinking.`,
      model: { ...model, reasoning: true } });
  }
  return { meta, pi, defaults, hints };
}

/** @brief 模型行与 piRowExpect 不同的地方（说明开头、两种标记、"(from pi)" 的悬停、提示的种类与文字）。 */
function piRowStateProblems(state, want, entry) {
  const thinking = want.pi.includes('reasoning') ? state.meta.includes('Supports thinking (from pi)') : true;
  const ok = state.meta.startsWith(want.meta) && thinking && same([...state.pi].sort(), [...want.pi].sort())
    && same([...state.defaults].sort(), [...want.defaults].sort())
    && state.piTitles.every((title) => title === piRowTitle(entry.provider))
    && same(state.hints.map((hint) => [hint.kind, hint.text]), want.hints.map((hint) => [hint.kind, hint.text]));
  return ok ? [] : [brief({ got: state, want: { ...want, hints: want.hints.map((hint) => hint.kind) } }, 500)];
}

/**
 * @brief 设置页里这几个模型行此刻与配置、pi 的条目一致（piRowExpect）：等到一致或 10 秒。
 * @param models ref → 配置里的模型
 * @return 不一致的地方（按 ref）
 */
async function piRowsNow(card, { models, entries }) {
  const problems = {};
  for (const [ref, model] of Object.entries(models)) {
    const entry = entries.get(model.id);
    const want = piRowExpect(model, entry);
    const state = await pollFor(() => modelRowState(modelRowOf(card, ref)),
      (value) => piRowStateProblems(value, want, entry).length === 0, 10000);
    const found = piRowStateProblems(state, want, entry);
    if (found.length) problems[ref] = found;
  }
  return problems;
}

/** @brief 配置里这个提供商的这几个模型：ref → 模型。 */
async function piModels(provider, ids) {
  const models = (await modelsGet(ctx.page)).config.providers.find((item) => item.id === provider.id).models;
  return Object.fromEntries(ids.map((id) => [`${provider.id}/${id}`, models.find((model) => model.id === id)]));
}

/**
 * @brief 点一条 pi 的提示的 Use（§8）：配置里的这个模型变成提示的 Use 保存的模型（models.saveModel，没有 thinkingLevel）；
 *        录制里记一步界面发的命令，再像界面一样读 models.get。
 * @return { ref, kind, at（点的时刻）, saved }
 */
async function piUse(card, { provider, ref, hint }) {
  const at = Date.now();
  await modelRowOf(card, ref).locator(`[data-testid="model-hint"][data-kind="${hint.kind}"] `
    + '[data-action="use-reported"]').click();
  const id = ref.slice(provider.id.length + 1);
  const now = await pollFor(() => piModels(provider, [id]), (value) => same(value[ref], hint.model), 15000);
  await recUiCommand(ctx.page, { type: 'models.saveModel', providerId: provider.id, model: hint.model },
    `UI: Use on "${hint.text}" (${ref}) sent this command (sent by the UI; checked against the config)`);
  await recCmd(ctx.page, { type: 'models.get' });
  return { ref, kind: hint.kind, at, saved: same(now[ref], hint.model) };
}

/**
 * @brief 依次点 pi 的提示的 Use，每次点按配置算出的第一条（先 flash、再 hinted），直到没有提示（最多 6 次）；每次之后
 *        记一条检查：配置变成 Use 保存的模型，模型行的标记与提示照新配置。
 * @return 点过的 { ref, kind, at, saved }
 */
async function piUseAll(card, { provider, ids, entries }) {
  const used = [];
  for (let round = 0; round < 6; round += 1) {
    const models = await piModels(provider, ids);
    const next = Object.entries(models).map(([ref, model]) => ({ ref,
      hint: piRowExpect(model, entries.get(model.id)).hints[0] })).find((item) => item.hint);
    if (!next) break;
    const use = await piUse(card, { provider, ...next });
    const problems = await piRowsNow(card, { models: await piModels(provider, ids), entries });
    record(`MD-17 real GLM: Use on "${next.hint.text}" (${next.ref}) saves ${brief(next.hint.model, 300)}; the model `
      + 'rows then read the "(from pi)" and "(default)" marks and the hints from pi\'s model list for the new values',
    use.saved && Object.keys(problems).length === 0, brief(problems));
    used.push(use);
  }
  return used;
}

/**
 * @brief 加入、探针、模型行的提示与 Use、有效窗口，写下 fixture md-glm-pi-card，再在 flash 上跑会话的一轮
 *        （glmPiDrive 的后半）。
 */
async function piDriveAdd(card, { provider, picks, configured, result, entries, meta }) {
  const ids = [picks.flash.id, picks.hinted.id];
  const refs = ids.map((id) => `${provider.id}/${id}`);
  const since = Date.now() - 1000;
  const added = await piAdd(card, { provider, ids, result, configured });
  const probed = added ? await piProbed(refs, refs.map(() => since)) : [];
  await shot('glm-pi-probed');
  const problems = added ? piProfileProblems(refs, probed, await recCmd(ctx.page, { type: 'models.get' }))
    : [`${ids.join(', ')} were not added as the checklist showed`];
  if (added) {
    const rows = await piRowsNow(card, { models: await piModels(provider, ids), entries });
    record(`MD-17 real GLM: after the probes the rows of ${refs.join(' and ')} read "(from pi)" where the config `
      + `equals pi's value (hover "${piRowTitle('Z.AI')}"), "(default)" on Mori's defaults, and the hints from pi's `
      + 'model list only for values that are still the defaults (no "Server reports …" hint)',
    Object.keys(rows).length === 0, brief(rows));
    const used = await piUseAll(card, { provider, ids, entries });
    problems.push(...await piAfterUses(refs, used));
  }
  await saveFixture('md-glm-pi-card', meta, problems);
  if (added) await piEditBack(card, { provider, ref: refs[0], entry: entries.get(ids[0]) });
  if (added) await piTurn(refs[0]);
}

/**
 * @brief 用 Edit 改一个取自 pi 的值（models-settings.md“取自 pi”：改成别的值后不再标，改回又标；2026-10-26 补，模型层屏的
 *        覆盖审查）：ref 的 Max output 改成 pi 的值减 1，这一项不再写“(from pi)”（窗口照写）；改回 pi 的值又写。fixture
 *        已经写下，这两次保存不进录制；每次保存后指纹变了、自动重新探测（标记只看配置与 pi 的条目，不等它跑完）。
 * @param entry pi 的模型表里这个模型的条目（piEntriesAt）
 */
async function piEditBack(card, { provider, ref, entry }) {
  const id = ref.slice(provider.id.length + 1);
  const save = async (value) => {
    await modelRowOf(card, ref).locator('[data-action="edit"]').click();
    const form = card.getByTestId('model-form');
    await form.waitFor({ timeout: 10000 });
    await form.getByLabel('Max output', { exact: true }).fill(String(value));
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await form.waitFor({ state: 'detached', timeout: 15000 });
    await pollFor(() => piModels(provider, [id]), (models) => models[ref]?.maxTokens === value, 15000);
    return pollFor(() => modelRowState(modelRowOf(card, ref)),
      (state) => state.pi.includes('maxTokens') === (value === entry?.maxTokens), 10000);
  };
  const changed = await save(entry.maxTokens - 1);
  const back = await save(entry.maxTokens);
  record(`MD-17 real GLM: Edit sets the Max output of ${ref} to ${thousands(entry.maxTokens - 1)} and its "(from pi)" `
    + `goes away while the window keeps it; setting it back to pi's ${thousands(entry.maxTokens)} with Edit brings `
    + '"(from pi)" back', !changed.pi.includes('maxTokens') && changed.pi.includes('contextWindow')
    && back.pi.includes('maxTokens'), brief({ changed: changed.pi, back: back.pi }));
}

/**
 * @brief 等这几个模型的探针跑完（每个从 since 起；Use 之后的重新探测从点 Use 的时刻起）。
 * @return 每个跑完了没有
 */
async function piProbed(refs, since) {
  const done = [];
  for (const [i, ref] of refs.entries()) done.push(await waitProbed(ctx.page, ref, since[i], PROBE_MS));
  return done;
}

/**
 * @brief 探针跑完的档案（§7.2）：ready；窗口服务没报告（context.reported 为 null）、有效窗口就是配置的（取自 pi 的值
 *        不算报告，不参与有效窗口）；catalog 有 pi 的窗口。记一条检查。
 * @return 问题（写 fixture 时用）
 */
function piProfileProblems(refs, probed, info) {
  const problems = refs.flatMap((ref, i) => {
    const profile = info.profiles[ref];
    const model = info.config.providers.flatMap((p) => p.models.map((m) => [`${p.id}/${m.id}`, m]))
      .find(([key]) => key === ref)?.[1];
    const found = profileProblems(profile, probed[i]);
    if (profile && model && !(profile.context.reported === null && profile.context.effective === model.contextWindow
      && profile.catalog?.contextWindow > 0)) {
      found.push(`context ${JSON.stringify(profile.context)}, catalog ${JSON.stringify(profile.catalog)}`);
    }
    return found.map((text) => `${ref}: ${text}`);
  });
  record(`MD-17 real GLM: the probes of ${refs.join(' and ')} complete with status ready; their profiles have no `
    + 'server-reported window and the effective window is the configured one (values from pi\'s model list are not '
    + 'reported values), while the profile view has pi\'s window', problems.length === 0, brief(problems));
  return problems;
}

/**
 * @brief Use 都点完之后（§8）：点过 pi 的三种提示；你设的 Max output（PI_OWN_MAX）没被提示改成 pi 的；等重新探测跑完，
 *        像界面一样读 config.get 与 models.get（回放的最后一个设置页）。记一条检查。
 * @return 问题（写 fixture 时用）
 */
async function piAfterUses(refs, used) {
  const kinds = [...new Set(used.map((use) => use.kind))];
  const own = used.some((use) => use.ref === refs[1] && use.kind === 'pi-max-output');
  const last = refs.map((ref) => used.findLast((use) => use.ref === ref)?.at ?? 0);
  const probed = await piProbed(refs, last);
  await recCmd(ctx.page, { type: 'config.get' });
  const info = await recCmd(ctx.page, { type: 'models.get' });
  const ownMax = info.config.providers.flatMap((p) => p.models.map((m) => [`${p.id}/${m.id}`, m]))
    .find(([ref]) => ref === refs[1])?.[1].maxTokens;
  const problems = [...PI_HINT_KINDS.filter((kind) => !kinds.includes(kind)).map((kind) => `no Use on ${kind}`),
    ...(own || ownMax !== PI_OWN_MAX ? [`Max output of ${refs[1]}: ${ownMax}`] : []),
    ...used.filter((use) => !use.saved).map((use) => `${use.ref} ${use.kind} not saved`),
    ...refs.filter((ref, i) => !probed[i]).map((ref) => `${ref}: the probes after the Use did not finish`)];
  record(`MD-17 real GLM: the Uses covered the three hints from pi's model list (${PI_HINT_KINDS.join(', ')}); `
    + `the Max output ${PI_OWN_MAX} you set on ${refs[1]} stayed and was never offered pi's value; the `
    + 're-probes after the Uses finished', problems.length === 0, brief({ problems, used }));
  return problems;
}

/**
 * @brief 会话的一轮（MD-17，给模型看的变化）：ref 的配置是 pi 的值（Max output 131,072 发成 max_tokens，
 *        kernel/modelSession.ts 传配置的 maxTokens），在临时项目（piTurnProject）的新会话里选它、发 PI_TURN；
 *        回复来自 ref、停止原因 stop、没有错误卡（z.ai 接受这个请求，没有 400）。之后回到设置 → Models。
 */
async function piTurn(ref) {
  const project = ctx.piProject;
  const model = (await piModels({ id: ref.slice(0, ref.indexOf('/')) }, [ref.slice(ref.indexOf('/') + 1)]))[ref];
  await leaveSettings(ctx.page);
  await openTrusted(project);
  await chooseRange(ctx.page, ref);
  const file = await activeSessionFile(ctx.page);
  const h = pageHelpers(ctx.page);
  await h.send(PI_TURN);
  await h.idle(TURN_MS).catch(() => {});
  await shot('glm-pi-turn');
  const last = assistantMessages(file).at(-1) ?? null;
  const cards = await cardCounts(ctx.page);
  const errors = await ctx.page.locator('[data-testid="error-card"]').allTextContents();
  record(`MD-17 real GLM: one session turn on ${ref} with the values from pi's model list (Max output `
    + `${thousands(model?.maxTokens ?? 0)}, which Mori sends as max_tokens; Context window `
    + `${thousands(model?.contextWindow ?? 0)}; Supports thinking ${onOff(model?.reasoning)}) completes: the reply `
    + 'comes from it with stop reason "stop" and there is no error card (no 400 from the server)',
  last?.ref === ref && last.stopReason === 'stop' && cards.errors === 0,
  brief({ model, last, cards, errors: errors.map((text) => oneLine(text, 300)) }));
  const sent = loggedPayloads().filter((line) => line.last.includes(PI_TURN));
  record(`MD-17 real GLM: the request of that turn (logged by a project extension on pi's before_provider_request) `
    + `carries max_tokens ${thousands(model?.maxTokens ?? 0)}, the Max output taken from pi's model list`,
  sent.length > 0 && sent.every((line) => line.max_tokens === model?.maxTokens),
  brief({ sent, want: model?.maxTokens }));
  await openModelsSettings(ctx.page);
}

/**
 * @brief 测试准备（synthetic test setup，§13.1）：glm-pi 会话一轮用的临时项目。Mori 启动之前建好；不用授权（2026-10-26
 *        网络区域删掉，WP-05：任何提供商在任何项目里都能用）。
 * @return 做了什么（一句，进 fixture 的 notes）
 */
function piTurnProject() {
  const { root, project } = prepareProject('mori-md-real-');
  ctx.projects.push(root);
  ctx.piProject = project;
  ctx.piPayloads = join(root, 'payloads.jsonl');
  const extension = join(project, '.pi', 'extensions', 'payload-log.ts');
  mkdirSync(dirname(extension), { recursive: true });
  writeFileSync(extension, payloadLogSource(ctx.piPayloads));
  return 'a temporary project for the glm-pi session turn (no grant: network zones were removed on 2026-10-26), '
    + 'with a project extension that logs the max_tokens of each request pi sends (before_provider_request)';
}

/**
 * @brief 测试准备（synthetic test setup，2026-10-26 补）：临时项目里的 pi 扩展，在 pi 的 before_provider_request 里把每个
 *        请求体的模型、max_tokens 与最后一条用户消息（前 4000 字）追加到 file（项目外的一个文件），不改请求体。只记这三项，
 *        不记认证头和 key。
 */
function payloadLogSource(file) {
  return [
    "import { appendFileSync } from 'node:fs';",
    '',
    'const text = (content) => (typeof content === \'string\' ? content',
    '  : (content ?? []).map((part) => part?.text ?? \'\').join(\'\'));',
    '',
    'export default function (pi) {',
    "  pi.on('before_provider_request', (event) => {",
    '    const payload = event.payload ?? {};',
    "    const users = (payload.messages ?? []).filter((message) => message.role === 'user');",
    '    const line = { model: payload.model ?? null, max_tokens: payload.max_tokens ?? null,',
    '      last: text(users.at(-1)?.content).slice(0, 4000) };',
    `    appendFileSync(${JSON.stringify(file)}, \`\${JSON.stringify(line)}\\n\`);`,
    '    return undefined;',
    '  });',
    '}',
    '',
  ].join('\n');
}

/** @brief 临时项目里的扩展记下的请求（payloadLogSource）；没有文件时为空。 */
const loggedPayloads = () => (existsSync(ctx.piPayloads ?? '') ? readFileSync(ctx.piPayloads, 'utf8')
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : []);

/** @brief 打开 project（系统对话框换成直接返回它）；问信任时选“Trust workspace”（项目里有扩展），等会话就绪。 */
async function openTrusted(project) {
  await stubFolder(ctx.app, project);
  await ctx.page.getByTestId('sidebar').getByRole('button', { name: 'Open folder…', exact: true }).click();
  const trust = ctx.page.getByTestId('trust-dialog');
  if (await trust.waitFor({ timeout: 10000 }).then(() => true, () => false)) {
    await trust.getByRole('button', { name: 'Trust workspace', exact: true }).click();
  }
  await waitReady(ctx.page);
}

/**
 * @brief glm-pi：卡上 Fetch models → 每一行照 pi 的模型表（测试自己读）核对取自 pi 的值与标记 → 手填一个 pi 有、列表
 *        没有的 id（不写 From pi）→ 加入两个 pi 有条目的模型（改过值）→ 探针 → 模型行的标记、pi 的提示与 Use →
 *        有效窗口；全程录成回放 fixture md-glm-pi-card；最后在加入的第一个模型上跑会话的一轮。
 */
async function glmPiDrive() {
  const provider = ctx.found.glm;
  const card = cardOf(ctx.page, provider.id);
  await card.scrollIntoViewIfNeeded();
  const configured = (await modelsGet(ctx.page)).config.providers.find((item) => item.id === provider.id).models
    .map((model) => model.id);
  const entries = piEntriesAt(provider.baseUrl);
  const origin = new URL(provider.baseUrl).origin;
  await openFixture();
  await card.locator('[data-action="fetch-models"]').click();
  const state = await waitFetched(card, FETCH_MS);
  const rows = await readRows(card);
  await shot('glm-pi-fetched');
  const result = await recordedDiscover(provider);
  const listed = !state.listError && state.checklist && result.listError === null;
  const wants = listed ? result.models.map((model) => piRowWant(model, entries.get(model.id) ?? null)) : [];
  const problems = wants.flatMap((want) => piRowProblems(rows.find((row) => row.id === want.id), want));
  const piIds = wants.filter((want) => want.pi.length > 0).map((want) => want.id);
  record(`MD-17 real GLM: Fetch models on the ${provider.id} card shows on every row what pi's own model list gives `
    + `for ${origin} where the server reported nothing: pi's Context window, Max output and `
    + 'Supports thinking with "From pi" (hover naming the pi provider) on the rows pi lists, the defaults with '
    + '"Default" on the others; Image input is never taken from pi (unticked)',
  listed && piIds.length > 0 && problems.length === 0,
  brief({ listError: state.listError, piIds, problems: problems.slice(0, 4), pi: [...entries.keys()] }));
  if (listed) await piManualRow(card, { entries, rows, origin });
  const picks = listed ? piPicks(rows, entries) : { flash: null, hinted: null };
  const meta = piFixtureMeta(provider, configured, picks);
  if (!picks.flash || !picks.hinted) {
    record('MD-17 real GLM: two listed models that pi\'s model list has for this address can be ticked', false,
      brief({ rows: rows.map((row) => row.id), pi: [...entries.keys()] }));
    await saveFixture('md-glm-pi-card', meta, ['no two models from pi\'s model list could be added']);
    return;
  }
  await piPrepare(card, picks);
  await piDriveAdd(card, { provider, picks, configured, result, entries, meta });
}

/** @brief md-glm-pi-card 的外层说明（saveFixture 的 meta）。 */
function piFixtureMeta(provider, configured, { flash, hinted }) {
  const names = flash && hinted ? `${flash.id} and ${hinted.id}` : 'two models pi lists for this address';
  return { provider, model: `${provider.id}/${configured[0]}`, covers: ['MD-07', 'MD-13', 'MD-17'],
    what: `the ${provider.id} card checklist with values from pi's model list, the add of ${names}, the Uses on the `
      + 'hints from pi\'s model list and Settings after the probes',
    description: `Settings → Models: Fetch models on the ${provider.id} card with the saved key; Add a model ID `
      + `with an id pi lists but the server doesn't (left unticked); tick ${names} (the first with Max output set to `
      + `the default, the second set back to the defaults with Max output ${PI_OWN_MAX} and thinking off), Add 2 `
      + 'models; after the probes Use on each hint from pi\'s model list (models.saveModel), then the models.get after '
      + 'the re-probes' };
}

// ---------- record（经转发代理录响应体样本） ----------

/**
 * @brief 等代理安静下来：启动时读版本（§7.3）对每个经代理的提供商都发过列表请求（最多等 15 秒），并且最后一个已过去
 *        3 秒（最多再等 30 秒）。同一个提供商同时进行的读取会合并（§5.3），不等的话卡上的拉取可能接上读版本那一次，
 *        录下的列表请求多出几个。
 */
async function proxyQuiet(proxy, ids) {
  await pollFor(() => ids.filter((id) => !proxy.captures.some((item) => item.provider === id)),
    (left) => left.length === 0, 15000, 500);
  await pollFor(() => proxy.captures.at(-1)?.t ?? 0, (t) => Date.now() - t >= 3000, 30000, 500);
}

/** @brief 卡上 Fetch models，等结果，取代理录下的这个提供商的列表响应，关掉清单。ids 为经代理的全部提供商。 */
async function proxiedFetch(proxy, id, ids) {
  const card = cardOf(ctx.page, id);
  await card.scrollIntoViewIfNeeded();
  await proxyQuiet(proxy, ids);
  const since = Date.now();
  await card.locator('[data-action="fetch-models"]').click();
  const state = await waitFetched(card, FETCH_MS);
  const captures = await pollFor(() => proxy.captures.filter((item) => item.provider === id && item.t >= since),
    (list) => list.length > 0, 5000);
  await shot(`record-${id}`);
  const close = card.locator('[data-action="close-form"]');
  if (await close.count()) await close.click();
  return { state, captures };
}

/** @brief 样本的路径（相对 tests/fixtures/discovery）。 */
const bodyPath = (name) => `bodies/${name}`;

/** @brief DeepSeek /models：200、有模型列表、id 与第一次启动卡上的清单相同 → bodies/deepseek-models.json。 */
function writeDeepSeekBody({ state, captures }) {
  const item = captures.at(-1);
  const problems = [];
  if (!item) problems.push('no list request of DeepSeek reached the proxy');
  else if (!item.auth) problems.push('the list request carried no Authorization header');
  else if (item.status !== 200 || !Array.isArray(item.body?.data)) {
    problems.push(`status ${item.status}, body ${brief(item.body, 300)}`);
  } else if (ctx.deepseekIds && !same(item.body.data.map((row) => row.id), ctx.deepseekIds)) {
    problems.push('the recorded ids differ from the checklist of the direct run');
  }
  if (!state.checklist) problems.push(`the proxied card shows ${brief(state.listError ?? state.commandError)}`);
  if (item && leaked(item.body)) problems.push(LEAKED);
  const note = 'DeepSeek /models with the saved key, recorded by tests/ui/md-real.mjs through a local proxy '
    + '(status and body only)';
  const file = item ? writeFixture(bodyPath('deepseek-models.json'), bodyEnvelope(item, note), problems) : null;
  record('MD-14 real record: DeepSeek /models with the saved key answered 200 with a model list (the ids the direct '
    + 'run\'s checklist showed) and is recorded as bodies/deepseek-models.json (status and body, no headers)',
  problems.length === 0, `${file ?? 'nothing written'} — ${brief(problems)}`);
}

/** @brief 最后一个列表响应的状态与卡上的结果对得上（§3.2：列表 2xx，rejected 401/403，no_list 404/405）。 */
function lastStatusProblem(kind, last) {
  const ok = kind === 'list' ? last.status >= 200 && last.status < 300
    : kind === 'rejected' ? [401, 403].includes(last.status) : kind === 'no_list' ? [404, 405].includes(last.status)
      : kind === 'invalid';
  return ok ? null : `the last list request answered ${last.status} while the card showed ${kind}`;
}

/**
 * @brief GLM 的列表请求（1–3 个列表地址，§3.2 的顺序，加 Anthropic 形状的翻页）→ bodies/glm-models-<n>.json；
 *        都带 Authorization 头，最后一个的状态与卡上的结果对得上；先删掉上一次录的。
 */
function writeGlmBodies({ state, captures }) {
  const kind = state.listError?.kind ?? (state.checklist ? 'list' : null);
  const problems = [];
  // §3.2：列表地址最多试 3 次；Anthropic 形状的列表翻页（after_id）最多再取 4 页（§11 的 5 页）
  const pages = captures.filter((item) => new URL(item.url).searchParams.has('after_id')).length;
  const attempts = captures.length - pages;
  if (attempts === 0 || attempts > 3 || pages > 4) {
    problems.push(`${attempts} list attempts and ${pages} further pages reached the proxy`);
  }
  if (captures.some((item) => !item.auth)) problems.push('a list request carried no Authorization header');
  if (kind === null) problems.push(`the proxied card shows ${brief(state.commandError)}`);
  else if (captures.length) problems.push(lastStatusProblem(kind, captures.at(-1)));
  if (ctx.glmOutcome && kind !== ctx.glmOutcome) {
    problems.push(`outcome ${kind}, the direct run showed ${ctx.glmOutcome}`);
  }
  if (captures.some((item) => leaked(item.body))) problems.push(LEAKED);
  const found = problems.filter(Boolean);
  const dir = join(FIXTURES, 'bodies');
  if (found.length === 0) {
    for (const name of readdirSync(dir).filter((item) => /^glm-models-\d+\.json$/.test(item))) rmSync(join(dir, name));
  }
  const note = (index) => `GLM list request ${index + 1} of ${captures.length} (spec §3.2 order) with the saved key; `
    + `the card showed ${kind}. Recorded by tests/ui/md-real.mjs through a local proxy (status and body only)`;
  const files = captures.map((item, index) => writeFixture(bodyPath(`glm-models-${index + 1}.json`),
    bodyEnvelope(item, note(index)), found));
  const statuses = captures.map((item) => item.status).join(', ');
  record(`MD-14 real record: the GLM list requests with the saved key (${statuses}) match what the card showed `
    + `(${kind}) and are recorded as bodies/glm-models-<n>.json (status and body, no headers)`, found.length === 0,
  `${files.join(', ') || 'nothing written'} — ${brief(found)}`);
}

// ---------- key 方式：只经界面建数据目录（步骤与问题清单在 v1-real-helpers.mjs，与 v1-models-real.mjs 共用） ----------

/**
 * @brief key 方式第一步：全新的数据目录启动到首次启动表单，经表单接上 DeepSeek（共用的 firstRunDeepSeek，截图用这里的
 *        shot：截之前查窗口的文字里有没有 key），按共用的 firstRunProblems 记一条检查，关掉 Mori。
 * @return 保存的 DeepSeek 提供商 id；没接上时为 null
 */
async function setupFirstRun(userData) {
  await launchMori(userData, 'connection-form');
  const run = await firstRunDeepSeek(ctx.page, { baseUrl: keyEnv.urls.deepseek, key: keyEnv.keys.deepseek, shot });
  const { doc, provider, picked } = run;
  const problems = firstRunProblems(run, keyEnv.urls.deepseek);
  record('MD-14 real setup: first run with DeepSeek (Base URL typed, API key typed into its password field): Fetch '
    + `models opens the checklist with "Detected: DeepSeek"; with only ${doc?.id ?? 'a documented model'} ticked and `
    + 'Test connection saves the provider (the Base URL host, OpenAI-compatible, one saved key, '
    + 'only that model), connects, and its probes finish with tool calling verified', problems.length === 0,
  brief({ problems, ids: run.rows.map((row) => row.id), picked, text: run.text, provider: providerBrief(provider) }));
  await closeApp();
  return problems.length === 0 ? provider.id : null;
}

/**
 * @brief OpenRouter（md-real.mjs 自己的选法，给共用的 addProviderUi）：只勾第一个免费、有工具支持的模型（freeToolRow，
 *        共用的 tickOnly）。
 */
async function chooseFree(form, state, rows) {
  const target = state.checklist ? freeToolRow(rows) : undefined;
  return target ? tickOnly(form, target.id) : null;
}

/**
 * @brief key 方式第二步：重新打开 Mori（首次启动保存过，进入三栏布局），设置 → Models → Add provider（共用的
 *        addProviderUi）加 GLM（chooseGlm，问题清单 glmAddProblems）与 OpenRouter（chooseFree，问题清单 addedProblems），
 *        各记一条检查；等它们的探针跑完（之后复制这个目录时不会因档案没写完而重新探测）再关掉 Mori。
 * @return { glm, openrouter }：两个新提供商的 id；没加成的为 null
 */
async function setupProviders(userData) {
  await startApp(userData);
  const glm = await addProviderUi(ctx.page, { baseUrl: keyEnv.urls.glm, key: keyEnv.keys.glm, choose: chooseGlm });
  // z.ai 的 Anthropic 兼容列表用 hasMore、lastId（规格更正 4，§3.2、§3.3）：拿到列表时 Detected 写 Anthropic-compatible
  // server；列表错误时没有 Detected 一行（§6.1）。两种情况都在 glmAddProblems 里
  const glmProblems = glmAddProblems(glm, keyEnv.urls.glm);
  record(`MD-14 real setup: Add provider for GLM (${keyEnv.urls.glm} and its API key in the password field): Fetch `
    + 'models shows the model list with "Detected: Anthropic-compatible server" (or a list error without a Detected '
    + `line); ${GLM_MANUAL_ID} is entered with Add a model ID (or ticked when the server lists it) and Add saves the `
    + 'provider (the Base URL host, its API type, one saved key) with only it', glmProblems.length === 0,
  brief({ problems: glmProblems, detected: glm.state.detected,
    listError: glm.state.listError, title: glm.state.title, ids: glm.rows.map((row) => row.id).slice(0, 40),
    provider: providerBrief(glm.provider) }));
  const free = await addProviderUi(ctx.page, { baseUrl: OPENROUTER_BASE, key: keyEnv.keys.openrouter,
    choose: chooseFree });
  const freeProblems = addedProblems(free, OPENROUTER_BASE, 'Detected: OpenRouter');
  record(`MD-14 real setup: Add provider for OpenRouter (${OPENROUTER_BASE} and its API key in the password field): `
    + 'Fetch models opens the checklist with "Detected: OpenRouter"; the first free model with tool support (id '
    + 'ending ":free", no tool-support hint) is ticked alone and Add saves the provider (openrouter.ai, '
    + 'OpenAI-compatible, one saved key) with only it', freeProblems.length === 0, brief({
    problems: freeProblems, title: free.state.title, picked: free.picked, provider: providerBrief(free.provider) }));
  await shot('setup-providers');
  for (const added of [glm, free].filter((item) => item.provider && item.picked)) {
    const ref = `${added.provider.id}/${added.picked}`;
    const probed = await waitProbed(ctx.page, ref, added.since, PROBE_MS);
    const profile = (await modelsGet(ctx.page)).profiles[ref];
    console.log(`[md-real] setup: probes of ${ref} ${probed ? 'finished' : 'did not finish'}: ${redact(brief(
      profileBrief(profile), 400))}`);
  }
  await closeApp();
  return { glm: glmProblems.length ? null : glm.provider.id, openrouter: freeProblems.length ? null
    : free.provider.id };
}

/**
 * @brief key 方式：建一个全新的数据目录，只经界面接上 DeepSeek、GLM 与 OpenRouter（setupFirstRun、setupProviders）。
 *        出错时记一条失败。
 * @return { userData, ids: { deepseek, glm } }；没建成时为 null
 */
async function buildKeyDataDir() {
  const userData = mkdtempSync(join(tmpdir(), 'mori-md-real-keys-'));
  ctx.dataDirs.push(userData);
  console.log(`[md-real] key mode: building a new data dir in ${userData} through the UI`);
  try {
    const deepseek = await setupFirstRun(userData);
    if (!deepseek) return null;
    const { glm, openrouter } = await setupProviders(userData);
    return glm && openrouter ? { userData, ids: { deepseek, glm } } : null;
  } catch (error) {
    record('MD-14 real setup: the data dir was built through the UI (first run with DeepSeek, Add provider for GLM and '
      + 'OpenRouter, each API key typed into its password field)', false, oneLine(error, 600));
    await shot('setup-error');
    await closeApp();
    return null;
  }
}

/**
 * @brief key 方式的最后一条检查（§9）：输进 Mori 的 key 不以明文出现在 Mori 窗口的文字里（每次截图之前查，shot），
 *        不出现在 Mori 的输出里，也不出现在这次用过的数据目录里（Mori 加密保存的 credentials.json 之外的全部文件）。
 *        在删掉 credentials.json 之后查。
 */
function leakCheck() {
  const report = findSecrets(ctx.dataDirs, ctx.logs.join('\n'), secrets);
  const found = [...report.found, ...ctx.shownKeys.map((name) => `Mori's window text before the screenshot ${name}`)];
  record('MD-14 real: none of the API keys typed into Mori appears in plain text in Mori\'s window text (checked '
    + 'before every screenshot), in Mori\'s output or in any file of the data dirs this run used '
    + `(${ctx.dataDirs.length}), outside the encrypted credentials.json (§9)`,
  found.length === 0 && report.unreadable.length === 0 && report.files > 0, brief({ ...report, found }));
}

// ---------- 执行 ----------

/** 驱动：名字、做法（record 另起一次启动） */
const DRIVES = [
  { name: 'deepseek', run: deepseekDrive },
  { name: 'openrouter', run: openrouterDrive },
  { name: 'glm', run: glmDrive },
  { name: 'glm-pi', id: 'MD-17', run: glmPiDrive },
];

/** @brief 删掉临时数据目录里 key 的密文副本，打印数据目录的位置。 */
function dropCredentials(userData) {
  rmSync(join(userData, 'credentials.json'), { force: true });
  console.log(`[md-real] data in ${userData} (credentials.json removed)`);
}

/** @brief 跑一个驱动：抛错时记一条失败（编号为驱动的 id，没有时 MD-14）、截图、按 Esc 关掉对话框，接着跑下一个。 */
async function runDrive(drive) {
  try {
    await drive.run();
  } catch (error) {
    record(`${drive.id ?? 'MD-14'} real ${drive.name}: the drive and its checks ran to the end`, false,
      oneLine(error, 600));
    await shot(`${drive.name}-error`);
    await ctx.page?.keyboard.press('Escape').catch(() => {});
  }
}

/** @brief 复制出的数据目录里模型配置用到的文件都在（key 只是密文副本）。 */
function copiedProblems(userData) {
  return ['credentials.json', 'Local State', 'model-config.json'].filter((name) => !existsSync(join(userData, name)))
    .map((name) => `${name} was not copied`);
}

/** @brief 第一次启动的测试准备之后：GLM 里没有 GLM-5.3，DeepSeek 至少有一个文档的模型还没加入。 */
function directSetupProblems(userData) {
  const problems = copiedProblems(userData);
  if (problems.length) return problems;
  const config = readJson(join(userData, 'model-config.json'));
  const ids = (id) => config.providers.find((item) => item.id === id)?.models.map((model) => model.id) ?? [];
  if (ids(ctx.found.glm.id).includes(GLM_MANUAL_ID)) problems.push(`${GLM_MANUAL_ID} is still in ${ctx.found.glm.id}`);
  if (DEEPSEEK_DOCS.models.every((doc) => ids(ctx.found.deepseek.id).includes(doc.id))) {
    problems.push(`every documented DeepSeek model is already in ${ctx.found.deepseek.id}`);
  }
  return problems;
}

/** @brief 第二次启动的测试准备之后：DeepSeek 与 GLM 的地址都指向代理，代理知道它们原来的 origin。 */
function recordSetupProblems(data, ids) {
  const problems = copiedProblems(data.userData);
  if (problems.length) return problems;
  const config = readJson(join(data.userData, 'model-config.json'));
  for (const id of ids) {
    const baseUrl = config.providers.find((item) => item.id === id)?.baseUrl ?? '';
    if (!baseUrl.startsWith(`http://127.0.0.1:${PROXY_PORT}/p/${id}`) || !data.routes[id]) {
      problems.push(`${id}: ${baseUrl} → ${data.routes[id]}`);
    }
  }
  return problems;
}

/**
 * @brief 测试准备不合格时记一条失败（准备是测试自己做的，合格时不算一条检查，只打印做了什么）。
 * @return 合格为 true
 */
function setupOk(name, problems, notes) {
  if (problems.length) record(name, false, brief({ problems, notes }));
  else console.log(`[md-real] ${name}: ${notes.join('; ') || 'no change was needed'}`);
  return problems.length === 0;
}

/** @brief 第一次启动：直接对真实地址跑选中的驱动。 */
async function directRun(drives) {
  const data = prepareDirect(source, ctx.found);
  if (drives.some((drive) => drive.name === 'glm-pi')) data.notes.push(piTurnProject());
  ctx.setupNotes = data.notes;
  ctx.dataDirs.push(data.userData);
  try {
    const name = 'MD-14 real setup: the copied data dir (encrypted files only, synthetic test setup applied) has the '
      + `model files, no ${GLM_MANUAL_ID} in ${ctx.found.glm.id} and a documented DeepSeek model not yet in `
      + ctx.found.deepseek.id;
    if (!setupOk(name, directSetupProblems(data.userData), data.notes)) return;
    await startApp(data.userData);
    for (const drive of drives) await runDrive(drive);
  } catch (error) {
    record('MD-14 real: Mori started with the copied data dir and opened Settings → Models', false,
      oneLine(error, 600));
    await shot('direct-error');
  } finally {
    // 只在 Mori 启动了时记（没启动时上面已记了失败）
    if (ctx.page) {
      record('MD-14 real: the page has no errors while the drives run', ctx.pageErrors.length === 0,
        brief(ctx.pageErrors.slice(0, 3)));
    }
    await closeApp();
    dropCredentials(data.userData);
    // glm-pi 的会话一轮用的临时项目
    for (const root of ctx.projects.splice(0)) rmSync(root, { recursive: true, force: true });
  }
}

/** @brief 第二次启动（record）：经转发代理拉取 DeepSeek 与 GLM 的列表，写响应体样本。 */
async function recordRun() {
  const { deepseek, glm } = ctx.found;
  const ids = [deepseek.id, glm.id];
  const data = prepareRecord(source, ids, PROXY_PORT);
  ctx.dataDirs.push(data.userData);
  let proxy = null;
  try {
    const name = `MD-14 real record setup: the second copy of the data dir points ${ids.join(' and ')} at the proxy `
      + `http://127.0.0.1:${PROXY_PORT}/p/<id><path> (synthetic test setup)`;
    if (!setupOk(name, recordSetupProblems(data, ids), [JSON.stringify(data.routes)])) return;
    proxy = await startListProxy(PROXY_PORT, data.routes);
    await startApp(data.userData);
    writeDeepSeekBody(await proxiedFetch(proxy, deepseek.id, ids));
    writeGlmBodies(await proxiedFetch(proxy, glm.id, ids));
  } catch (error) {
    record('MD-14 real record: the proxied run fetched both lists', false, oneLine(error, 600));
    await shot('record-error');
  } finally {
    // 只在代理与 Mori 都起来了时记（没起来时上面已记了失败）
    if (proxy && ctx.page) {
      record(`MD-14 real record: the page has no errors and the proxy on 127.0.0.1:${PROXY_PORT} forwarded every `
        + 'request', ctx.pageErrors.length === 0 && proxy.errors.length === 0, brief({
        page: ctx.pageErrors.slice(0, 3), proxy: proxy.errors.slice(0, 3) }));
    }
    await closeApp();
    stopListProxy(proxy);
    dropCredentials(data.userData);
  }
}

/**
 * @brief 写下卡上的回放录制之后跑 node tests/ui/md-replay.mjs（§13.1 回放层）：md-real 不带 --only 时不带 --only（全部
 *        录制，含这次写下的，结果 test-results/md-replay.json）；带 --only 时只回放这次写下的（--only <录制>，结果
 *        md-partial-replay.json；测试分层第 2 条，2026-10-26）。读它写的结果，记一条 MD-14 检查：退出码为 0、结果文件是
 *        这次写的、这次写下的每份录制都有检查、全部检查都通过。这次一份都没写下（核对不通过，写到了 rejected）时记一条
 *        失败，不跑。
 */
function replayCheck() {
  const written = ctx.cardFixtures;
  const name = 'MD-14 real replay: node tests/ui/md-replay.mjs replays the card recordings this run wrote '
    + `(${written.join(', ') || 'none'}; every recording when md-real runs without --only), and all its checks pass`;
  if (written.length === 0) {
    record(name, false, 'no card recording was written by this run (see the MD-14 real record checks)');
    return;
  }
  const args = only ? ['--only', written.join(',')] : [];
  const result = only ? REPLAY_RESULTS.partial : REPLAY_RESULTS.all;
  const started = Date.now();
  console.log(`[md-real] replaying the recordings: node tests/ui/md-replay.mjs ${args.join(' ')}`);
  const run = spawnSync(process.execPath, [join(appRoot, 'tests/ui/md-replay.mjs'), ...args], { cwd: appRoot,
    stdio: 'inherit', timeout: REPLAY_MS });
  const fresh = existsSync(result) && statSync(result).mtimeMs >= started;
  const checks = fresh ? readJson(result).checks : [];
  // 卡上录制的检查名里有" <录制名>"（md-replay.mjs 的 card 检查）；md-glm 的检查不含" md-glm-card"
  const missing = written.filter((item) => !checks.some((check) => check.name.includes(` ${item}`)));
  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  record(name, run.status === 0 && fresh && checks.length > 0 && missing.length === 0 && failed.length === 0,
    brief({ exit: run.status, signal: run.signal, error: run.error?.message ?? null, fresh, checks: checks.length,
      missing, failed: failed.slice(0, 5) }));
}

/** @brief key 方式跑之前的检查：三个 key 都有值、地址是 http(s) URL、没给只用于 --source 的参数；不合格时返回一句说明。 */
function keyModeProblem() {
  const missing = Object.entries(KEY_VARS).filter(([id]) => !keyEnv.keys[id]).map(([, name]) => name);
  if (missing.length) {
    return `Missing --source <Mori data dir>, or for the key mode the env vars ${missing.join(', ')}.`;
  }
  const bad = Object.entries(URL_VARS).filter(([id]) => !/^https?:\/\/[^/\s]+/i.test(keyEnv.urls[id]))
    .map(([, [name]]) => name);
  if (bad.length) return `${bad.join(', ')} must be an http or https URL.`;
  const sourceOnly = ['deepseek', 'glm'].filter((name) => process.argv.includes(`--${name}`));
  return sourceOnly.length ? `${sourceOnly.map((name) => `--${name}`).join(', ')} only applies with --source.` : null;
}

/**
 * @brief 跑之前的检查：参数的值、--only 的名字、--exe；--source 方式下数据目录（checkSource），key 方式下环境变量
 *        （keyModeProblem）。不合格时返回一句说明。
 */
function startProblem() {
  const bare = VALUE_FLAGS.filter((name) => process.argv.includes(`--${name}`) && !argValue(name));
  if (bare.length) return `${bare.map((name) => `--${name}`).join(', ')} needs a value.`;
  if (only?.length === 0) return `Empty --only; expected some of ${DRIVE_NAMES.join(', ')}.`;
  const unknown = (only ?? []).filter((name) => !DRIVE_NAMES.includes(name));
  if (unknown.length) return `Unknown --only ${unknown.join(', ')}; expected ${DRIVE_NAMES.join(', ')}.`;
  if (exePath && !existsSync(exePath)) return `--exe ${exePath} does not exist.`;
  if (!source) return keyModeProblem();
  const setup = checkSource(source, { deepseek: argValue('deepseek'), glm: argValue('glm') });
  if (setup.error) return setup.error;
  ctx.found = setup.found;
  return null;
}

/**
 * @brief key 方式：经界面建数据目录（buildKeyDataDir），再像 --source 一样检查它（checkSource，提供商 id 用建的时候
 *        得到的）。不合格时记一条失败。
 * @return 可以跑驱动为 true
 */
async function keySource() {
  const built = await buildKeyDataDir();
  if (!built) return false;
  const setup = checkSource(built.userData, built.ids);
  if (setup.error) {
    record('MD-14 real setup: the data dir built through the UI has DeepSeek and GLM with saved keys', false,
      setup.error);
    return false;
  }
  source = built.userData;
  ctx.found = setup.found;
  return true;
}

/** @brief 跑选中的驱动（第一次启动）、回放、record（第二次启动）。 */
async function runAll() {
  const { deepseek, glm, openrouter } = ctx.found;
  console.log(`[md-real] DeepSeek ${deepseek.id} (${deepseek.baseUrl}), GLM ${glm.id} (${glm.baseUrl}), OpenRouter `
    + `${openrouter ? `${openrouter.id} (card)` : 'by Add provider'}`);
  const selected = (name) => !only || only.includes(name);
  const drives = DRIVES.filter((drive) => selected(drive.name));
  if (drives.length) await directRun(drives);
  if (drives.some((drive) => CARD_DRIVES.includes(drive.name))) replayCheck();
  if (selected('record')) await recordRun();
}

/** @brief 整个套件：检查参数（不合格时不启动、不写结果），两次启动，写结果。 */
async function main() {
  const problem = startProblem();
  if (problem) {
    console.error(`[md-real] not run: ${problem}`);
    console.error('[md-real] usage: node tests/ui/md-real.mjs --source <Mori data dir> [--exe <Mori.exe>] '
      + `[--only ${DRIVE_NAMES.join(',')}] [--deepseek <provider id>] [--glm <provider id>]`);
    console.error('[md-real]   or (key mode) with MD_REAL_DEEPSEEK_KEY, MD_REAL_GLM_KEY and MD_REAL_OPENROUTER_KEY set '
      + '(MD_REAL_DEEPSEEK_URL, MD_REAL_GLM_URL optional): node tests/ui/md-real.mjs [--exe <Mori.exe>] '
      + `[--only ${DRIVE_NAMES.join(',')}]`);
    console.error(`[md-real] no result file was written (test-results/${resultFile} is left as it was)`);
    return 1;
  }
  mkdirSync(shots, { recursive: true });
  if (ctx.found || await keySource()) await runAll();
  if (ctx.keyMode) {
    dropCredentials(ctx.dataDirs[0]);
    leakCheck();
  }
  await sleep(200);
  return write(resultFile) ? 0 : 1;
}

// 没接住的报错（例如 Playwright 的报错带着输入框里填的值）也先把 key 换成 *** 再打印
process.exitCode = await main().catch((error) => {
  console.error(`[md-real] ${redact(error?.stack ?? error)}`);
  return 1;
});
