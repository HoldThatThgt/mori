// 从真实的 App（开发构建 out/）录制一键拉取模型回放用的 fixture（tests/fixtures/discovery/ui/*.json；
// docs/specs/model-discovery.md §13.1 的回放层，MD-07、MD-13）。做法同 mem-record.mjs：页面里的录制器直接通过
// window.mori（与界面相同的进程桥）发命令，命令的写法与界面发出的相同（state/settings.ts 的 discoverModels 与 writeModels
// 之后的 models.get、进入设置页时的 config.get 与 models.get；ProviderForm.tsx 的 models.saveProvider；Checklist.tsx 的
// newTarget、prefillDraft、默认勾选、Select all、改值与 Max output 随窗口变；Providers.tsx 卡上的 Fetch models），
// 记下命令、结果和后台进程转发的全部事件及其时间。三个场景都不填 API key：fixture 里没有 key，也不存请求头。
//   md-openrouter（source real，MD-07）：Add provider 里 Fetch models https://openrouter.ai/api/v1（公开列表，不带 key；
//     真实录制的清单）。
//   md-glm（source real，MD-07）：Fetch models https://open.bigmodel.cn/api/paas/v4（不带 key，服务拒绝；真实录制的
//     列表错误）。
//   md-deepseek（source synthetic，MD-07、MD-13；它的场景（按地址两次 Add provider、typed 列表、§8 的五种提示、
//     Legacy 卡）对真实的 DeepSeek 录不出，所以 md-real.mjs 录下真实的 md-deepseek-card.json（MD-14）后它仍保留，§13.1）：
//     合成端点的 rich 形状（DeepSeek 式字段）给出清单：Select all，fake-ds-vision 的 Max output 改为 4096、取消 Supports
//     thinking 与 Image input，fake-ds-long 的 Context window 改小为 32768（Max output 随之按 §4.3 取报告值），
//     fake-ds-alwaysthink（合成端点总先回一段思考）的 Context window 改大为 262144、Max output 改为 200000（加入后
//     §8 的 Use 把窗口改回报告值时 Max output 一起改小），Add 3 models；再从 typed 形状（一个 llm、一个 embedding，
//     什么都不报告）按默认勾选 Add 1 model；等全部探针结束，回到设置页（models.get 与 mori.profiles 里有 reported）；
//     最后在 Legacy endpoint 卡上 Fetch models（已有提供商：列表里 fake-legacy 已加入，fake-coder 是唯一能加入的一行）。
//   md-shapes（source synthetic，MD-07、MD-13；这些形状没有能用的真实部署，§13.1 的合成端点）：Add provider 里依次
//     Fetch models 一个有 id 含空格的行的列表（vllm 默认形状：fake-coder 与 "bad id"，后者 Can’t add this model）、
//     一个空列表、一个 ollama 形状的列表（olla-ps 的窗口来自 /api/ps，olla-ctx 来自 num_ctx、带 no_tools，olla-train
//     只有训练窗口、带 trained_window）；Ollama 的清单把 olla-ps 的 Context window 改小为 4096 后 Add 3 models，等探针
//     结束，回到设置页（olla-ps 有 "Server reports a context window of 8,192."，olla-train 的窗口 not reported），
//     点这条提示的 Use（models.saveModel 与之后的 models.get），录下之后后台进程转发的 mori.profiles：olla-ps 先在
//     running 里（重新探测，界面为 Re-verifying…），最后完成。
// 准备（synthetic test setup）：数据目录里一个本机区域的提供商 Legacy endpoint（legacy/fake-legacy，合成端点 4862 的
// vllm 默认形状，列表为 fake-legacy、fake-coder），档案是一键拉取模型之前的写法（没有 auto.meta，推理字段
// reasoning_content，已验证；model-discovery.md §7.2、§8 的旧档案），默认范围 legacy/fake-legacy；它让 App 不进首次启动，
// 回放时设置页从录下的 models.get 开始。
// 录完先核对场景要的东西真的发生了（check）；不符合时不写进 fixtures，写到 test-results/md-record/<名字>.rejected.json，
// 退出码为 1。
// 用法（在 app/ 下，out/ 是当前的构建；MORI_APP_DIR 可指向别的构建）：
//   node tests/ui/md-record.mjs [--only md-openrouter,md-glm,md-deepseek,md-shapes] [--out <目录>]
// 端口（§13.1 回放与录制用 4860–4879）：4860 rich、4861 typed、4862 Legacy endpoint、4863 ollama、4864 id 含空格、
// 4865 空列表。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appRoot, arg, launch, oneLine, removeUserData, sleep } from './lib.mjs';
import { tempUserData } from './tb-helpers.mjs';
import { baseOf, modelOf, profileOf, providerOf, startEndpoint, stopEndpoint } from './v1-switch-helpers.mjs';

const only = arg('only')?.split(',');
const outDir = arg('out') ? resolve(arg('out')) : join(appRoot, 'tests/fixtures/discovery/ui');
const rejectedDir = join(appRoot, 'test-results/md-record');
/** 录制的日期（fixture 的 recorded） */
const TODAY = new Date().toISOString().slice(0, 10);
/** 等探针结束的时限 */
const PROBE_WAIT_MS = 180000;

/** 准备里的提供商（synthetic test setup）：合成端点 4862 的 vllm 默认形状，档案是旧写法 */
/** 列表里有它自己的模型（卡上的 Fetch models 标 Added）和另一个能加入的模型（只有一行能加入，默认勾上，§6.2） */
const LEGACY = { port: 4862, provider: 'legacy', model: 'fake-legacy', name: 'Legacy endpoint',
  env: { FAKE_MODELS: 'fake-legacy,fake-coder' } };
/** md-deepseek 的两个合成端点：rich（DeepSeek 式字段）与 typed（服务报告类型、不报告窗口与输出） */
const RICH = { port: 4860, env: { FAKE_LIST_SHAPE: 'rich',
  FAKE_MODELS: 'fake-ds-vision,fake-ds-long,fake-ds-alwaysthink' } };
const TYPED = { port: 4861, env: { FAKE_LIST_SHAPE: 'typed', FAKE_MODELS: 'fake-coder,fake-embed' } };
/** 真实的两个地址（不带 key） */
const OPENROUTER = 'https://openrouter.ai/api/v1';
const GLM = 'https://open.bigmodel.cn/api/paas/v4';
/**
 * md-deepseek 里清单的改动（synthetic）：fake-ds-vision 的 Max output、fake-ds-long 改小后的窗口、fake-ds-alwaysthink
 * 改大后的窗口与 Max output（大于服务报告的窗口：加入后 §8 的 Use 把窗口改回报告值时 Max output 一起改小）
 */
const EDITED_MAX = 4096;
const LOWERED_WINDOW = 32768;
const RAISED_WINDOW = 262144;
const RAISED_MAX = 200000;
/**
 * md-shapes 的三个合成端点：ollama 形状（三种窗口来源）、一个有 id 含空格的行的列表（vllm 默认形状，类型不明）、
 * 空列表（FAKE_MODELS 只有逗号）
 */
const OLLAMA = { port: 4863, env: { FAKE_LIST_SHAPE: 'ollama', FAKE_MODELS: 'olla-ps,olla-ctx,olla-train' } };
const SPACED = { port: 4864, env: { FAKE_MODELS: 'fake-coder,bad id' } };
const EMPTY = { port: 4865, env: { FAKE_MODELS: ',' } };
/** md-shapes 里 Use 的模型：合成端点的 /api/ps 报告它的窗口 8192（server.mjs 开头注释的 ollama 一项） */
const OLLAMA_PS = 'olla-ps';
const OLLAMA_PS_WINDOW = 8192;
/** md-shapes 里 olla-ps 在清单里改小后的窗口：加入后模型行有窗口的提示，Use 把它改回 8192 并重新探测 */
const LOWERED_PS_WINDOW = 4096;

// ---------- 页面里的录制器 ----------

/**
 * @brief 页面里的录制器（同 mem-record.mjs）：记录命令、结果和事件。命令一条接一条发（上一条有了结果才发下一条）：
 *        回放桥把结果配给它之前最近一条同类型命令，两条同类型的命令交错时会配错。
 */
function installRecorder() {
  const rec = {
    t0: performance.now(),
    steps: [],
    chain: Promise.resolve(),
    log(entry) { this.steps.push({ t: Math.round(performance.now() - this.t0), ...entry }); },
    cmd(command) {
      const send = async () => {
        this.log({ command });
        try {
          const result = await window.mori.request(command);
          this.log({ result: { type: command.type, value: result } });
          return result;
        } catch (error) {
          this.log({ result: { type: command.type, error: error.message } });
          throw error;
        }
      };
      const sent = this.chain.then(send, send);
      this.chain = sent.catch(() => {});
      return sent;
    },
  };
  window.mori.onEvent((envelope) => rec.log({ envelope }));
  window.__rec = rec;
}

// ---------- 界面的写法（独立实现 Checklist.tsx、ProviderForm.tsx 的规则，model-discovery.md §6.1、§6.2、§4.3） ----------

/** @brief 去掉首尾空白和结尾的 / 的地址（§6.1 第 3 项）。 */
const bare = (url) => url.trim().replace(/\/+$/, '');

/**
 * @brief Add provider 拉取后预填、没改过任何字段时的提供商表单（§6.1 第 3、4 项；fields.tsx toProviderForm）：
 *        建议的 Base URL 与填的不同时换进框，Name、API type 取结果，区域为 zone（suggestZone 的建议值），
 *        Concurrency per key 为默认的 4，兼容选项为空。
 * @param typed Base URL 框里填的地址
 */
function providerFormOf(typed, result, zone) {
  const baseUrl = bare(result.baseUrl) !== bare(typed) ? result.baseUrl : typed;
  return { name: result.name.trim(), baseUrl: baseUrl.trim(), api: result.api, zone, concurrency: 4, compat: {} };
}

/**
 * @brief 清单的行与默认勾选（§6.2）：chat 为真的勾上、为假的不勾、为 null 时能加入的行只有一行才勾；added、unusable 不勾。
 *        reportedMax 是服务报告的输出上限（改窗口时 §4.3 用它），没报告为 null。
 */
function rowsOf(result) {
  const usable = result.models.filter((m) => !m.added && m.unusable === null).length;
  return result.models.map((m) => ({ id: m.id, family: m.family, contextWindow: m.contextWindow,
    maxTokens: m.maxTokens, reasoning: m.reasoning, image: m.image, pickable: !m.added && m.unusable === null,
    picked: !m.added && m.unusable === null && (m.chat ?? usable === 1),
    reportedMax: m.reported.maxTokens ? m.maxTokens : null }));
}

/** @brief 改一行的窗口、没改过 Max output（§6.2、§4.3）：报告的输出上限小于新窗口时用它，否则为没报告时的默认值。 */
function setWindow(row, window) {
  row.contextWindow = window;
  row.maxTokens = row.reportedMax !== null && row.reportedMax < window ? row.reportedMax
    : Math.min(16384, Math.floor(window / 2));
}

/** @brief 勾选的行转成配置里的模型（Checklist.tsx toProviderModel）。 */
const toModel = (row) => ({ id: row.id, family: row.family, contextWindow: row.contextWindow,
  maxTokens: row.maxTokens, reasoning: row.reasoning, input: row.image ? ['text', 'image'] : ['text'] });

/**
 * @brief md-deepseek 的清单改动（synthetic）：Select all；fake-ds-vision 的 Max output 改为 4096、取消 Supports thinking
 *        与 Image input；fake-ds-long 的 Context window 改小（Max output 随之变）；fake-ds-alwaysthink 的 Context window
 *        改大为 262144、Max output 改为 200000。
 */
function editRich(rows) {
  for (const row of rows) row.picked = row.pickable;
  const vision = rows.find((row) => row.id === 'fake-ds-vision');
  Object.assign(vision, { maxTokens: EDITED_MAX, reasoning: false, image: false });
  setWindow(rows.find((row) => row.id === 'fake-ds-long'), LOWERED_WINDOW);
  const think = rows.find((row) => row.id === 'fake-ds-alwaysthink');
  setWindow(think, RAISED_WINDOW);
  think.maxTokens = RAISED_MAX;
  return rows;
}

/**
 * @brief §8 表第一行的 Use 保存的模型（独立实现 ModelRows.tsx 的规则）：窗口改为服务报告的 n；原来的 Max output
 *        不小于 n 时改为 16384 与 n 一半中较小的，否则不变。
 */
const useReportedWindow = (model, n) => ({ ...model, contextWindow: n,
  maxTokens: model.maxTokens >= n ? Math.min(16384, Math.floor(n / 2)) : model.maxTokens });

// ---------- 场景运行时的操作 ----------

/** @brief 一个场景运行时的操作（node 这边驱动页面里的录制器）。 */
function driver(state) {
  const page = () => state.page;
  const d = {
    cmd: (command) => page().evaluate((c) => window.__rec.cmd(c), command),
    steps: () => page().evaluate(() => window.__rec.steps),
    /** 开头像界面一样读会话列表与设置 */
    async start() {
      await d.cmd({ type: 'session.list' });
      await d.cmd({ type: 'config.get' });
    },
    /** 进入设置页（state/settings.ts：重新读 config.get，再读 models.get） */
    async openSettings() {
      await d.cmd({ type: 'config.get' });
      return d.cmd({ type: 'models.get' });
    },
    /** Add provider 里填 Base URL（API key 空着）后 Fetch models（Checklist.tsx newTarget：API type 没改过为 null） */
    discover: (baseUrl) => d.cmd({ type: 'models.discover', target: { kind: 'new', baseUrl, api: null,
      keySecret: null } }),
    /** 卡上的 Fetch models（Providers.tsx） */
    discoverProvider: (providerId) => d.cmd({ type: 'models.discover', target: { kind: 'provider', providerId } }),
    /** Add：models.saveProvider（API key 空着时不带 keySecret），成功后重新 models.get（writeModels） */
    async add(typed, result, rows) {
      const saved = await d.cmd({ type: 'models.saveProvider', id: null,
        provider: providerFormOf(typed, result, 'local'), models: rows.filter((row) => row.picked).map(toModel) });
      if (saved.error !== null) throw new Error(`models.saveProvider failed: ${saved.error}`);
      await d.cmd({ type: 'models.get' });
      return saved.providerId;
    },
    /** 模型行提示的 Use（ModelRows.tsx）：models.saveModel 带改过的模型、不带 thinkingLevel，成功后重新 models.get */
    async use(providerId, model) {
      const saved = await d.cmd({ type: 'models.saveModel', providerId, model });
      if (saved.error !== null) throw new Error(`models.saveModel failed: ${saved.error}`);
      await d.cmd({ type: 'models.get' });
    },
    /** 录制器已记下的步数 */
    count: () => page().evaluate(() => window.__rec.steps.length),
  };
  return Object.assign(d, probeWaits(page));
}

/** @brief 每 500 ms 在页面里算一次 test(arg)，为真时返回；超过 PROBE_WAIT_MS 时报错（what 写进错误）。 */
async function pollPage(page, test, arg, what) {
  const deadline = Date.now() + PROBE_WAIT_MS;
  for (;;) {
    if (await page().evaluate(test, arg)) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(500);
  }
}

/** @brief 等探针的两种方式（page 返回当前的页面）。 */
function probeWaits(page) {
  return {
    /** 等 refs 的探针都结束：最新一个 mori.profiles 里它们都有档案、不在探测中，也不在 running 里 */
    untilProbed: (refs) => pollPage(page, (want) => {
      const last = window.__rec.steps.findLast((s) => s.envelope?.event.type === 'mori.profiles')?.envelope.event;
      return Boolean(last) && want.every((ref) => last.profiles[ref] && last.profiles[ref].status !== 'probing'
        && !last.running.some((item) => item.ref === ref));
    }, refs, `the probes of ${refs.join(', ')}`),
    /**
     * 等 ref 重新探测完：第 start 步之后的 mori.profiles 里先有一个 ref 在 running 里（重新探测开始），在它之后
     * 最新的一个里 ref 不在 running 里、档案不在探测中
     */
    untilReprobed: (ref, start) => pollPage(page, ({ want, from }) => {
      const events = window.__rec.steps.slice(from).filter((s) => s.envelope?.event.type === 'mori.profiles')
        .map((s) => s.envelope.event);
      const began = events.findIndex((event) => event.running.some((item) => item.ref === want));
      const last = events.at(-1);
      return began >= 0 && began < events.length - 1 && last.profiles[want]?.status !== 'probing'
        && !last.running.some((item) => item.ref === want);
    }, { want: ref, from: start }, `the re-probe of ${ref}`),
  };
}

// ---------- 核对（在 node 里） ----------

const need = (ok, problem) => (ok ? [] : [problem]);
const failures = (steps) => steps.filter((s) => s.result?.error).map((s) => `${s.result.type}: ${s.result.error}`);
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

/** @brief 有结果之前就又发了一条命令的位置。 */
function overlaps(steps) {
  let pending = null;
  const out = [];
  steps.forEach((step, index) => {
    if (step.command) {
      if (pending) out.push(`${pending.type} then ${step.command.type} at ${index}`);
      pending = step.command;
    }
    if (step.result && pending?.type === step.result.type) pending = null;
  });
  return out;
}

/** @brief 命令里带了 key（keySecret 不为空，或 models.addKey）：fixture 里不能有 key。 */
const keyed = (steps) => steps.filter((s) => s.command && (s.command.type === 'models.addKey'
  || (s.command.keySecret ?? s.command.target?.keySecret ?? null) !== null));

/** @brief 共同的要求：开头是会话列表；没有失败的命令；命令不交错；没有 key；拉取的命令本身没失败、没被取消。 */
function common(steps) {
  const first = steps.find((s) => s.command)?.command;
  const discovers = pairs(steps, 'models.discover').filter((p) => p.value.error !== null || p.value.cancelled);
  return [...need(first?.type === 'session.list', 'the recording does not start with session.list'),
    ...need(failures(steps).length === 0, `failed commands: ${failures(steps).join('; ')}`),
    ...need(overlaps(steps).length === 0, `overlapping commands: ${overlaps(steps).slice(0, 3)}`),
    ...need(keyed(steps).length === 0, 'a command carries a key'),
    ...need(discovers.length === 0, `discover failed or cancelled: ${JSON.stringify(discovers.map((p) => p.value))}`)];
}

/** @brief 最后一个 models.get 里 ref 的档案。 */
const profileIn = (steps, ref) => pairs(steps, 'models.get').at(-1)?.value.profiles[ref];

/**
 * @brief md-deepseek 要的档案：每个都完成了、有 reported，最后一个 mori.profiles 里的 reported 与最后读到的 models.get
 *        相同；§8 的五种提示与没报告的标记都有来源；旧档案没有 reported。
 */
function deepseekProfiles(steps, ctx) {
  const refs = ['fake-ds-vision', 'fake-ds-long', 'fake-ds-alwaysthink'].map((id) => `${ctx.richId}/${id}`);
  const [vision, long, think] = refs.map((ref) => profileIn(steps, ref));
  const typed = profileIn(steps, `${ctx.typedId}/fake-coder`);
  const legacy = profileIn(steps, `${LEGACY.provider}/${LEGACY.model}`);
  const ready = [vision, long, think, typed].every((p) => p?.status === 'ready' && p.reported);
  const event = steps.findLast((s) => s.envelope?.event.type === 'mori.profiles')?.envelope.event;
  const evented = [...refs, `${ctx.typedId}/fake-coder`].every((ref) => event?.profiles[ref]?.reported
    && JSON.stringify(event.profiles[ref].reported) === JSON.stringify(profileIn(steps, ref)?.reported));
  return [...need(ready, `profiles not ready or without reported: ${JSON.stringify({ vision, long, think, typed })}`),
    ...need(evented, 'the last mori.profiles event does not carry the reported values of the last models.get'),
    ...need(vision?.reported?.reasoning === true && vision.reported.image === true
      && vision.reported.maxTokens > EDITED_MAX, `fake-ds-vision reported ${JSON.stringify(vision?.reported)}`),
    ...need(long?.reported?.contextWindow > LOWERED_WINDOW, `fake-ds-long reported ${JSON.stringify(long?.reported)}`),
    ...need(think?.reported?.contextWindow < RAISED_WINDOW && think.reported.contextWindow <= RAISED_MAX,
      `fake-ds-alwaysthink window ${JSON.stringify(think?.reported)}`),
    ...need(think?.reasoning.field !== 'none' && think?.reported?.reasoning !== true,
      `fake-ds-alwaysthink ${JSON.stringify(think?.reasoning)} ${JSON.stringify(think?.reported)}`),
    ...need(typed?.reported?.contextWindow === null && typed.reported.maxTokens === null,
      `typed fake-coder reported ${JSON.stringify(typed?.reported)}`),
    ...need(legacy?.reported === null && legacy.reasoning.field === 'reasoning_content',
      `legacy profile ${JSON.stringify(legacy?.reported)} ${legacy?.reasoning.field}`)];
}

// ---------- 场景 ----------

/** @brief md-openrouter：OpenRouter 的公开列表（真实录制）。 */
const openrouterScenario = {
  name: 'md-openrouter',
  source: 'real',
  address: OPENROUTER,
  covers: ['MD-07'],
  description: 'Settings → Models → Add provider: Fetch models from the real OpenRouter public list (no API key)',
  endpoints: [LEGACY],
  async run(d) {
    await d.start();
    await d.openSettings();
    await d.discover(OPENROUTER);
  },
  check(steps) {
    const result = pairs(steps, 'models.discover')[0]?.value;
    return [...common(steps), ...need(result?.listError === null && result.server?.kind === 'openrouter'
      && result.models.length > 20, `OpenRouter result ${oneLine(JSON.stringify(result), 300)}`)];
  },
};

/** @brief md-glm：GLM 的列表请求不带 key（真实录制的列表错误）。 */
const glmScenario = {
  name: 'md-glm',
  source: 'real',
  address: GLM,
  covers: ['MD-07'],
  description: 'Settings → Models → Add provider: Fetch models from the real GLM address without an API key',
  endpoints: [LEGACY],
  async run(d) {
    await d.start();
    await d.openSettings();
    await d.discover(GLM);
  },
  check(steps) {
    const result = pairs(steps, 'models.discover')[0]?.value;
    return [...common(steps), ...need(result?.listError !== null && result?.listError !== undefined,
      `GLM result has no list error: ${oneLine(JSON.stringify(result), 300)}`)];
  },
};

/** @brief md-deepseek：DeepSeek 式清单、加入后的设置页与卡上的 Fetch models（synthetic）。 */
const deepseekScenario = {
  name: 'md-deepseek',
  source: 'synthetic',
  address: [baseOf(RICH.port), baseOf(TYPED.port), baseOf(LEGACY.port)],
  covers: ['MD-07', 'MD-13'],
  description: 'Add provider from a DeepSeek-style list (Select all, one Max output lowered with thinking and image '
    + 'unticked, one Context window lowered, one Context window and Max output raised above the reported window), '
    + 'Add provider from a typed list (default picks), wait for the probes, reopen Settings, Fetch models on the '
    + 'Legacy endpoint card',
  endpoints: [LEGACY, RICH, TYPED],
  async run(d, ctx) {
    await d.start();
    await d.openSettings();
    const rich = await d.discover(baseOf(RICH.port));
    ctx.richId = await d.add(baseOf(RICH.port), rich, editRich(rowsOf(rich)));
    const typed = await d.discover(baseOf(TYPED.port));
    ctx.typedId = await d.add(baseOf(TYPED.port), typed, rowsOf(typed));
    const refs = [...rich.models.map((m) => `${ctx.richId}/${m.id}`), `${ctx.typedId}/fake-coder`];
    await d.untilProbed(refs);
    await d.openSettings();
    await d.discoverProvider(LEGACY.provider);
  },
  check(steps, ctx) {
    const [rich, typed, card] = pairs(steps, 'models.discover').map((p) => p.value);
    return [...common(steps),
      ...need(rich?.listError === null && rich.models.length === 3 && rich.models[0].reported.reasoning,
        `rich result ${oneLine(JSON.stringify(rich), 300)}`),
      ...need(typed?.models.some((m) => m.chat === true) && typed.models.some((m) => m.chat === false),
        `typed result ${oneLine(JSON.stringify(typed), 300)}`),
      ...need(card?.models.find((m) => m.id === LEGACY.model)?.added === true
        && card.models.filter((m) => !m.added && m.unusable === null).length === 1,
      `card result ${oneLine(JSON.stringify(card), 300)}`),
      ...deepseekProfiles(steps, ctx)];
  },
  sourceNote: ' against the synthetic endpoint (kept synthetic beside the real md-deepseek-card.json, MD-14: this '
    + 'recording\'s two Add provider flows, typed list, five §8 hints and Legacy card cannot be recorded against the '
    + 'real DeepSeek, §13.1)',
  syntheticSteps: 'the checklist edits before Add are synthetic',
};

/**
 * @brief md-shapes 的三次拉取：id 含空格的行列出、不能加入，另一行能加入；空列表没有列表错误；Ollama 的三种窗口来源
 *        （/api/ps、num_ctx、训练窗口）与两种提示，服务报告每行都是聊天模型。
 */
function shapesLists(steps) {
  const [spaced, empty, olla] = pairs(steps, 'models.discover').map((p) => p.value);
  const row = (id) => olla?.models.find((m) => m.id === id);
  return [...need(spaced?.models.map((m) => m.id).join() === SPACED.env.FAKE_MODELS
      && spaced.models[0].unusable === null && spaced.models[1].unusable === 'the ID contains spaces',
    `spaced result ${oneLine(JSON.stringify(spaced), 300)}`),
    ...need(empty?.listError === null && empty.models.length === 0,
      `empty result ${oneLine(JSON.stringify(empty), 300)}`),
    ...need(olla?.listError === null && olla.server?.kind === 'ollama' && olla.models.every((m) => m.chat === true)
      && row(OLLAMA_PS)?.contextWindow === OLLAMA_PS_WINDOW && row(OLLAMA_PS).hints.length === 0
      && row('olla-ctx')?.hints.includes('no_tools') && row('olla-train')?.hints.includes('trained_window'),
    `ollama result ${oneLine(JSON.stringify(olla), 300)}`)];
}

/**
 * @brief md-shapes 的 Use：之前的档案（olla-ps 已验证、报告窗口 8192；olla-train 只有训练窗口，reported 窗口为 null，
 *        §7.2）；Use 发出的 models.saveModel 成功、之后的 models.get 里窗口为 8192；Use 之后的 mori.profiles 里 olla-ps
 *        先在 running 里，最后一个里它不在 running、已验证，档案按新窗口探测（declared 8192，probedAt 比之前的新）。
 */
function shapesUse(steps, ctx) {
  const ref = `${ctx.ollaId}/${OLLAMA_PS}`;
  const [before, after] = [steps.slice(0, ctx.useFrom), steps.slice(ctx.useFrom)];
  const old = profileIn(before, ref);
  const train = profileIn(before, `${ctx.ollaId}/olla-train`);
  const [save] = pairs(after, 'models.saveModel');
  const saved = pairs(after, 'models.get').at(-1)?.value.config.providers.find((p) => p.id === ctx.ollaId)
    ?.models.find((m) => m.id === OLLAMA_PS);
  const events = after.filter((s) => s.envelope?.event.type === 'mori.profiles').map((s) => s.envelope.event);
  const began = events.findIndex((event) => event.running.some((item) => item.ref === ref));
  const last = events.at(-1);
  const done = last?.profiles[ref];
  return [...need(old?.status === 'ready' && old.tool_calling.state === 'verified'
      && old.reported?.contextWindow === OLLAMA_PS_WINDOW, `olla-ps before Use ${oneLine(JSON.stringify(old), 300)}`),
    ...need(train?.status === 'ready' && train.reported !== null && train.reported.contextWindow === null,
      `olla-train ${oneLine(JSON.stringify(train), 300)}`),
    ...need(save?.command.model.contextWindow === OLLAMA_PS_WINDOW && save.value.error === null
      && saved?.contextWindow === OLLAMA_PS_WINDOW, `Use ${JSON.stringify(save)} saved ${JSON.stringify(saved)}`),
    ...need(began >= 0 && began < events.length - 1 && !last.running.some((item) => item.ref === ref)
      && done?.status === 'ready' && done.tool_calling.state === 'verified'
      && done.context.declared === OLLAMA_PS_WINDOW && done.probedAt > old?.probedAt,
    `re-probe after Use: began at ${began} of ${events.length}, last ${oneLine(JSON.stringify(done), 300)}`)];
}

/**
 * @brief md-shapes：id 含空格的列表、空列表、Ollama 的清单与加入、探针后模型行提示的 Use 与重新探测（synthetic）。
 */
const shapesScenario = {
  name: 'md-shapes',
  source: 'synthetic',
  address: [baseOf(SPACED.port), baseOf(EMPTY.port), baseOf(OLLAMA.port), baseOf(LEGACY.port)],
  covers: ['MD-07', 'MD-13'],
  description: 'Add provider: Fetch models from a list with an ID containing a space, from an empty list and from an '
    + `Ollama-shaped list; lower the Context window of ${OLLAMA_PS} to ${LOWERED_PS_WINDOW} and Add 3 models, wait for `
    + 'the probes, reopen Settings, click Use on "Server reports a context window of 8,192." and record the re-probe',
  endpoints: [LEGACY, SPACED, EMPTY, OLLAMA],
  async run(d, ctx) {
    await d.start();
    await d.openSettings();
    await d.discover(baseOf(SPACED.port));
    await d.discover(baseOf(EMPTY.port));
    const olla = await d.discover(baseOf(OLLAMA.port));
    const rows = rowsOf(olla);
    setWindow(rows.find((row) => row.id === OLLAMA_PS), LOWERED_PS_WINDOW);
    ctx.ollaId = await d.add(baseOf(OLLAMA.port), olla, rows);
    await d.untilProbed(olla.models.map((m) => `${ctx.ollaId}/${m.id}`));
    const info = await d.openSettings();
    const ref = `${ctx.ollaId}/${OLLAMA_PS}`;
    const model = info.config.providers.find((p) => p.id === ctx.ollaId).models.find((m) => m.id === OLLAMA_PS);
    const reported = info.profiles[ref]?.reported?.contextWindow ?? null;
    if (reported === null || reported === model.contextWindow) {
      throw new Error(`${ref} has no context hint: ${JSON.stringify(info.profiles[ref]?.reported)}`);
    }
    ctx.useFrom = await d.count();
    await d.use(ctx.ollaId, useReportedWindow(model, reported));
    await d.untilReprobed(ref, ctx.useFrom);
  },
  check(steps, ctx) {
    return [...common(steps), ...shapesLists(steps), ...shapesUse(steps, ctx)];
  },
  sourceNote: ' against the synthetic endpoint (no real deployment of these server shapes was available, §13.1)',
  syntheticSteps: `lowering the Context window of ${OLLAMA_PS} before Add and the Use click are synthetic`,
};

const scenarios = [openrouterScenario, glmScenario, deepseekScenario, shapesScenario];

// ---------- 执行 ----------

/**
 * @brief 准备的数据目录（synthetic test setup）：Legacy endpoint 一个提供商、一个模型，旧写法的档案（没有 auto.meta，
 *        推理字段 reasoning_content），默认范围是这个模型。
 */
function seedUserData() {
  const userData = tempUserData('mori-md-record-data-');
  mkdirSync(join(userData, 'pi'), { recursive: true });
  const model = modelOf(LEGACY.model);
  const config = { version: 1, providers: [providerOf(LEGACY.provider, LEGACY.name, LEGACY.port, [model])],
    groups: [], normalDefault: `${LEGACY.provider}/${LEGACY.model}`, allowedZones: ['local', 'intranet'],
    projectZones: {} };
  writeFileSync(join(userData, 'model-config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const old = profileOf(baseOf(LEGACY.port), model);
  old.auto.field = 'reasoning_content';
  writeFileSync(join(userData, 'model-profiles.json'), `${JSON.stringify({ version: 1, profiles: [old] }, null, 2)}\n`);
  writeFileSync(join(userData, 'pi', 'settings.json'), '{}\n');
  return userData;
}

/** @brief 准备里写下的说明（fixture 的 notes）。 */
function setupNotes(scenario) {
  const notes = [`Setup (synthetic test setup, docs/specs/model-discovery.md §13.1): model-config.json has one local `
    + `provider ${LEGACY.name} (${LEGACY.provider}/${LEGACY.model}) on the synthetic endpoint ${baseOf(LEGACY.port)} `
    + '(vllm shape), with a profile written the way Mori wrote it before model discovery (no auto.meta, reasoning '
    + 'field reasoning_content, verified); default range legacy/fake-legacy', 'No API key was entered: the commands '
    + 'carry no key and the fixture stores no request headers'];
  if (scenario.source === 'synthetic') {
    const own = scenario.endpoints.filter((ep) => ep !== LEGACY).map((ep) => `${baseOf(ep.port)} `
      + Object.entries(ep.env).map(([key, value]) => `${key}=${value}`).join(' '));
    notes.push(`Synthetic endpoints: ${own.join('; ')} (tests/fake-endpoint/server.mjs); ${scenario.syntheticSteps}`);
  }
  return notes;
}

/** @brief 启动 Mori，装好录制器，清掉启动时记下的事件。 */
async function startMori(state) {
  state.app = await launch({ userData: state.userData });
  state.page = await state.app.firstWindow();
  await state.page.waitForFunction(() => Boolean(window.mori));
  await state.page.getByTestId('sidebar').waitFor({ timeout: 60000 });
  await state.page.evaluate(installRecorder);
}

/** @brief 录一个场景：准备、录制、核对，写出 fixture（不符合时写到 rejected）。 */
async function recordScenario(scenario) {
  const ctx = { endpoints: [], logs: [] };
  const state = { userData: seedUserData(), app: null, page: null };
  let steps = [];
  let problems;
  try {
    for (const ep of scenario.endpoints) ctx.endpoints.push(await startEndpoint(ep.port, ep.env, ctx.logs));
    await startMori(state);
    await scenario.run(driver(state), ctx);
    await sleep(500);
    steps = await state.page.evaluate(() => window.__rec.steps);
    problems = scenario.check(steps, ctx);
  } catch (error) {
    steps = await state.page?.evaluate(() => window.__rec.steps).catch(() => []) ?? [];
    problems = [`flow: ${oneLine(error?.stack ?? error, 600)}`];
  } finally {
    await state.app?.close().catch(() => {});
    for (const ep of ctx.endpoints) await stopEndpoint(ep);
    removeUserData(state.userData);
  }
  writeFixture(scenario, steps, problems);
}

/** @brief 写出 fixture；不符合时写到 test-results/md-record/<名字>.rejected.json。 */
function writeFixture(scenario, steps, problems) {
  const synthetic = scenario.source === 'synthetic';
  const fixture = { source: scenario.source, ...(synthetic ? { synthetic: true } : {}),
    note: `Recorded from the real App by tests/ui/md-record.mjs${synthetic ? scenario.sourceNote : ''}; do not edit `
      + 'by hand.',
    name: scenario.name, description: scenario.description, covers: scenario.covers, recorded: TODAY,
    address: scenario.address, endpoint: baseOf(LEGACY.port), model: `${LEGACY.provider}/${LEGACY.model}`,
    notes: setupNotes(scenario), recordedAt: new Date().toISOString(), steps };
  const dir = problems.length ? rejectedDir : outDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${scenario.name}${problems.length ? '.rejected' : ''}.json`),
    `${JSON.stringify(fixture, null, 1)}\n`);
  const summary = `${steps.length} steps, ${steps.filter((s) => s.envelope).length} events`;
  if (problems.length) {
    console.log(`FAIL ${scenario.name}: ${problems.join('; ')} — ${summary}`);
    process.exitCode = 1;
  } else {
    console.log(`RECORDED ${scenario.name}: ${summary}`);
  }
}

for (const scenario of scenarios) {
  if (only && !only.includes(scenario.name)) continue;
  await recordScenario(scenario);
}
