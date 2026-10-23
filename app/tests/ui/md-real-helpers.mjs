// 一键拉取模型真实层（tests/ui/md-real.mjs，docs/specs/model-discovery.md §13.1“真实”一行、§13.2 MD-14）的准备、
// 转发代理、页面里的录制器与界面操作：
// - 数据目录：检查负责人的数据目录（DeepSeek 与 GLM 两个提供商，各有 key，key 的 ref 在 credentials.json 里；只看键名，
//   不读、不打印、不解密密文）；用 lib.mjs scratchUserData 复制（只复制加密的 credentials.json、Local State 与模型配置、
//   档案、pi 设置），从不写来源目录。
// - 测试准备（synthetic test setup，只改复制出的 model-config.json）：GLM 的提供商里已有 GLM-5.3 时去掉它（还有别的模型时
//   删掉，分组成员与 normalDefault 跟着去掉，同模型层规格 §4.1 的连带改动；是唯一的模型时改名为 md-real-moved-GLM-5.3，
//   分组成员与 normalDefault 跟着改名），这样 Add a model ID 能手填它；DeepSeek 的提供商已有官方文档列出的全部模型时同样
//   去掉最后一个，清单里至少有一个能勾的文档模型。
// - 录制样本用的转发代理（synthetic test setup，只在录制那一次启动里）：另一份复制出的配置里 DeepSeek、GLM 的地址改指
//   http://127.0.0.1:<端口>/p/<提供商 id><原来的路径>（保留路径，§3.2 按路径里的 anthropic 段取前缀），档案的地址、键与
//   指纹跟着改；代理把 /p/<id><其余> 转发到原来的 origin + <其余>，请求头除 host 外原样带上、响应头原样带回，都不存；
//   只对列表请求（GET、路径以 /models 结尾，§3.2 的各个列表地址都是）留一份响应体，按 content-encoding 解压后存
//   { 状态, 响应体 }，另记这个请求带没带 Authorization 头（只记有没有）。content-encoding 的值只用来解压这份副本；
//   请求头里的 key 只在内存里用来把留下的响应体里出现的 key 换成 ***（同 §5.1），不存、不打印。
// - 页面里的录制器（格式同 md-record.mjs）：window.mori 是冻结的（contextBridge），包不住界面自己的命令；录制器在
//   begin 与 end 之间记下后台进程转发的全部事件和它自己经 window.mori.request 发的命令与结果（例如与卡上 Fetch models
//   同一个 models.discover）；界面自己发的写命令记成 { t, note, command }（note 写明是界面发的；command 由测试按界面的
//   操作写出、调用方再按配置的变化核对；回放桥按它数写命令的条数）；另外总留着最新的 mori.profiles 信封和每个模型
//   最近一次在 running 里的时刻（判断探针跑完）。
// - 界面：设置 → Models 的提供商卡、Add provider 表单、清单、列表错误与 Add a model ID，标识见
//   docs/v1/screens/models-settings.md“界面测试用的标识”；首次启动表单见 first-run.md。
// - key 方式（md-real.mjs 不给 --source、由环境变量给 key 时）：key 换成 *** 的写法（redactor）、在 Mori 的输出与数据目录
//   里找 key 的明文（findSecrets，只报出现的地方，不报 key）。
// 只读页面和磁盘、发界面操作；不改 Mori 的源码。

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { editModelConfig, oneLine, scratchUserData, sleep } from './lib.mjs';

/**
 * DeepSeek 官方文档给出的模型（2026-10-23 核对）：
 * - https://api-docs.deepseek.com/api/list-models 的响应样例：deepseek-flash 与 deepseek-v4-pro 的 context_window 都是
 *   1048576、max_output_tokens 都是 393216；input_modalities 前者 ["text", "image"]、后者 ["text"]；两者都有 effort
 *   （思考模式的强度）。
 * - https://api-docs.deepseek.com/quick_start/pricing 的模型表：两个都是 1M 窗口、最大输出 384K（= 393216），都支持思考模式
 *   （默认开），图片输入 deepseek-flash 支持、deepseek-v4-pro 不支持。
 * 清单按 §4.1 读：context_window → Context window，max_output_tokens（小于窗口）→ Max output，effort 存在 → Supports
 * thinking，input_modalities 含 image → Image input（不含为明确没有）。
 */
export const DEEPSEEK_DOCS = {
  checked: '2026-10-23',
  urls: ['https://api-docs.deepseek.com/api/list-models', 'https://api-docs.deepseek.com/quick_start/pricing'],
  models: [
    { id: 'deepseek-flash', contextWindow: 1048576, maxTokens: 393216, reasoning: true, image: true },
    { id: 'deepseek-v4-pro', contextWindow: 1048576, maxTokens: 393216, reasoning: true, image: false },
  ],
};

/** GLM 手填的模型 id（§13.2 MD-14） */
export const GLM_MANUAL_ID = 'GLM-5.3';
/** OpenRouter 的地址（公开列表不要 key，§13.2 MD-14） */
export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
/** 测试准备里改名的模型 id 前缀（synthetic） */
const MOVED_PREFIX = 'md-real-moved-';
/** 没报告时的窗口（§11，同 shared/models.ts 的 UNREPORTED_CONTEXT_WINDOW；这里独立写一遍用来核对界面） */
export const UNREPORTED_WINDOW = 128000;
/** @brief 没报告时的输出上限（§11）：16384 与窗口一半中较小的。 */
export const unreportedMax = (window) => Math.min(16384, Math.floor(window / 2));

/** @brief 读 JSON 文件。 */
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
/** @brief 一行概括（检查的 detail）。 */
export const brief = (value, max = 900) => oneLine(typeof value === 'string' ? value : JSON.stringify(value), max);
/** @brief CSS 属性选择器里的值（转义引号与反斜杠）。 */
export const attr = (value) => String(value).replace(/["\\]/g, '\\$&');
/** @brief 数字的千分位写法（模型行的数字，models-settings.md“Models 行与档案摘要”）。 */
export const thousands = (n) => Number(n).toLocaleString('en-US');

/**
 * @brief 按地址推出 Add provider 与首次启动预填的 API type（§3.4）：路径里有一段等于 anthropic（不分大小写），或主机是
 *        api.anthropic.com 时为 anthropic-messages，否则为 openai-completions。
 */
export function apiForUrl(url) {
  const { host, pathname } = new URL(url);
  const hinted = pathname.split('/').some((part) => part.toLowerCase() === 'anthropic') || host === 'api.anthropic.com';
  return hinted ? 'anthropic-messages' : 'openai-completions';
}

/**
 * @brief 清单里第一个能勾的免费模型（OpenRouter 的 id 以 ":free" 结尾），并且服务列出了它的工具支持（行上没有 no_tools
 *        提示：OpenRouter 的每一行都有 supported_parameters，§4.1 在其中没有 tools 时才加这个提示）；没有时为 undefined。
 *        加入后的自动探针因此不花钱，工具调用那几步发的 tools 参数服务也接受（2026-10-23 列出的免费、有工具支持的
 *        模型都支持思考，其中有的不接受关掉思考的请求：这样的模型探针按模型层规格以 error 结束）。
 */
export const freeToolRow = (rows) => rows.find((row) => row.pickable && !row.added && row.id.endsWith(':free')
  && !row.hints.includes('no_tools'));

/** @brief 把 text 里出现的每个 secret 换成 ***（同 §5.1 对服务原文的做法）；secrets 为空时原样返回。 */
export const redactor = (secrets) => (text) => secrets.reduce((out, secret) => out.split(secret).join('***'),
  String(text));

/**
 * @brief 在 text（Mori 的输出）与 dirs 下的每个文件（名字为 credentials.json 的除外：那是 Mori 加密保存的 key）里找 secrets
 *        的明文，UTF-8 与 UTF-16LE 两种写法都找（Chromium 的存储有时按 UTF-16 写字符串）。
 * @return { found: 出现的地方（"Mori output" 或文件路径）, unreadable: 读不出的文件（路径与原因）, files: 查过的文件数 }；
 *         不含 key 本身
 */
export function findSecrets(dirs, text, secrets) {
  const needles = secrets.flatMap((secret) => [Buffer.from(secret, 'utf8'), Buffer.from(secret, 'utf16le')]);
  const report = { found: secrets.some((secret) => text.includes(secret)) ? ['Mori output'] : [], unreadable: [],
    files: 0 };
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      if (!entry.isFile() || entry.name === 'credentials.json') continue;
      try {
        const data = readFileSync(path);
        report.files += 1;
        if (needles.some((needle) => data.includes(needle))) report.found.push(path);
      } catch (error) {
        report.unreadable.push(`${path}: ${error.code ?? error.message}`);
      }
    }
  };
  for (const dir of dirs.filter((item) => existsSync(item))) visit(dir);
  return report;
}

/** @brief 毫秒时刻的本地日历日期 `YYYY-MM-DD`（样本的录制日期）。 */
export function localDate(ms = Date.now()) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---------- 数据目录 ----------

/** @brief 提供商像不像 pattern 指的那一家（按 id、名称、地址）。 */
const looksLike = (provider, pattern) => pattern.test(`${provider.id} ${provider.name} ${provider.baseUrl}`);

/**
 * @brief 按 id（命令行给出时）或按 pattern 找提供商。
 * @return 提供商；没有时为 undefined
 */
function findProvider(config, id, pattern, not = null) {
  if (id) return config.providers.find((provider) => provider.id === id);
  return config.providers.find((provider) => provider !== not && looksLike(provider, pattern));
}

/**
 * @brief 检查负责人的数据目录（§13.1 真实层）：有 model-config.json、credentials.json、Local State；有 DeepSeek 与 GLM
 *        两个提供商（--deepseek、--glm 可以直接给 id），每个都有 key 且 key 的 ref 在 credentials.json 里（只看键名）。
 *        OpenRouter 的提供商可有可无（有时用卡上的 Fetch models，没有时用 Add provider）。
 * @param source --source 的值（已 resolve）；没给时为 null
 * @param ids { deepseek, glm }：命令行给出的提供商 id
 * @return { found: { deepseek, glm, openrouter（没有时 null） } }，或 { error }（一句说明，给命令行）
 */
export function checkSource(source, ids = {}) {
  if (!source) {
    return { error: 'Missing --source <Mori data dir>. Pass a Mori data dir where DeepSeek and GLM were saved with '
      + 'their keys (docs/specs/model-discovery.md §13.1).' };
  }
  if (!existsSync(source)) return { error: `The data dir ${source} does not exist.` };
  const missing = ['model-config.json', 'credentials.json', 'Local State'].filter((name) => !existsSync(join(source,
    name)));
  if (missing.length) return { error: `${missing.join(', ')} missing in ${source}; save the keys in Mori v1 first.` };
  let config;
  let refs;
  try {
    config = readJson(join(source, 'model-config.json'));
    refs = new Set(Object.keys(readJson(join(source, 'credentials.json'))));
  } catch (error) {
    return { error: `Cannot read the data dir ${source}: ${oneLine(error, 300)}` };
  }
  if (!Array.isArray(config?.providers)) return { error: `model-config.json in ${source} has no providers list.` };
  const deepseek = findProvider(config, ids.deepseek, /deepseek/i);
  const glm = findProvider(config, ids.glm, /glm|bigmodel|zhipu|z\.ai/i, deepseek);
  const names = config.providers.map((provider) => provider.id).join(', ') || 'none';
  for (const [name, provider] of [['DeepSeek', deepseek], ['GLM', glm]]) {
    if (!provider) return { error: `No ${name} provider in model-config.json (providers: ${names}).` };
    if (!(provider.keys ?? []).some((key) => refs.has(key.ref))) {
      return { error: `${provider.id} has no saved key in ${source}; save its key in Mori first.` };
    }
  }
  return { found: { deepseek, glm, openrouter: findProvider(config, null, /openrouter/i) ?? null } };
}

/**
 * @brief 分组成员与 normalDefault 里的 ref 换成 next（next 为 null 时去掉；变空的分组删掉，normalDefault 指向它时为
 *        null），同模型层规格 §4.1 删除模型的连带改动。
 */
function replaceRef(config, ref, next) {
  const emptied = [];
  for (const group of config.groups) {
    group.members = group.members.flatMap((member) => (member !== ref ? [member] : next ? [next] : []));
    if (group.members.length === 0) emptied.push(group.id);
  }
  config.groups = config.groups.filter((group) => group.members.length > 0);
  if (config.normalDefault === ref) config.normalDefault = next;
  else if (emptied.includes(config.normalDefault)) config.normalDefault = null;
}

/**
 * @brief 测试准备（synthetic）：让提供商里没有 modelId（复制出的配置）。还有别的模型时删掉它；是唯一的模型时改名为
 *        md-real-moved-<id>（提供商至少要有一个模型）。
 * @return 改了什么（一句，写进检查的 detail）
 */
export function freeModel(config, providerId, modelId) {
  const provider = config.providers.find((item) => item.id === providerId);
  const ref = `${providerId}/${modelId}`;
  if (provider.models.length > 1) {
    provider.models = provider.models.filter((model) => model.id !== modelId);
    replaceRef(config, ref, null);
    return `removed ${ref} from the copied model-config.json`;
  }
  const moved = `${MOVED_PREFIX}${modelId}`;
  provider.models[0].id = moved;
  replaceRef(config, ref, `${providerId}/${moved}`);
  return `renamed ${ref} (the provider's only model) to ${providerId}/${moved} in the copied model-config.json`;
}

/**
 * @brief 直接对真实地址走查用的数据目录：复制（scratchUserData），再做测试准备（freeModel：GLM-5.3；DeepSeek 已有文档的
 *        全部模型时最后一个）。
 * @return { userData, notes（改了什么） }
 */
export function prepareDirect(source, found) {
  const userData = scratchUserData(source);
  const notes = [];
  editModelConfig(userData, (config) => {
    const glm = config.providers.find((item) => item.id === found.glm.id);
    if (glm.models.some((model) => model.id === GLM_MANUAL_ID)) notes.push(freeModel(config, glm.id, GLM_MANUAL_ID));
    const deepseek = config.providers.find((item) => item.id === found.deepseek.id);
    const documented = DEEPSEEK_DOCS.models.map((model) => model.id);
    if (documented.every((id) => deepseek.models.some((model) => model.id === id))) {
      notes.push(freeModel(config, deepseek.id, documented.at(-1)));
    }
  });
  return { userData, notes };
}

/**
 * @brief 档案的地址、键与指纹换成代理的地址（档案的内容不变，键与指纹里的地址是开头的 "<baseUrl>|"），启动时不因地址变了
 *        重新探测。
 * @param moves 原地址 → 代理的地址
 */
function moveProfiles(file, moves) {
  if (!existsSync(file)) return;
  const data = readJson(file);
  for (const profile of data.profiles ?? []) {
    const to = moves[profile.baseUrl];
    if (!to) continue;
    profile.key = profile.key.replace(`${profile.baseUrl}|`, `${to}|`);
    profile.fingerprint = profile.fingerprint.replace(`${profile.baseUrl}|`, `${to}|`);
    profile.baseUrl = to;
  }
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * @brief 录制样本用的数据目录（synthetic test setup）：复制，再把 ids 里的提供商的地址改指转发代理
 *        http://127.0.0.1:<port>/p/<id><原来的路径>，档案跟着改。
 * @param ids 要经代理的提供商 id
 * @return { userData, routes（提供商 id → 原来的 origin，给 startListProxy）, bases（id → 原来的地址） }
 */
export function prepareRecord(source, ids, port) {
  const userData = scratchUserData(source);
  const routes = {};
  const bases = {};
  const moves = {};
  editModelConfig(userData, (config) => {
    for (const provider of config.providers.filter((item) => ids.includes(item.id))) {
      const real = new URL(provider.baseUrl);
      const path = real.pathname.replace(/\/+$/, '');
      routes[provider.id] = real.origin;
      bases[provider.id] = provider.baseUrl;
      moves[provider.baseUrl] = `http://127.0.0.1:${port}/p/${provider.id}${path}`;
      provider.baseUrl = moves[provider.baseUrl];
    }
  });
  moveProfiles(join(userData, 'model-profiles.json'), moves);
  return { userData, routes, bases };
}

// ---------- 转发代理（synthetic test setup，只留列表请求的状态与响应体） ----------

/** @brief 列表请求（§3.2）：GET，路径（不含 query）以 /models 结尾。 */
const isListRequest = (method, url) => method === 'GET' && new URL(url).pathname.endsWith('/models');

/** @brief 按 content-encoding 解压留下的响应体副本。 */
function decoded(buffer, encoding) {
  switch (String(encoding ?? 'identity').trim().toLowerCase()) {
    case 'identity': return buffer;
    case 'gzip': case 'x-gzip': return zlib.gunzipSync(buffer);
    case 'deflate': return zlib.inflateSync(buffer);
    case 'br': return zlib.brotliDecompressSync(buffer);
    case 'zstd': return zlib.zstdDecompressSync(buffer);
    default: throw new Error(`unsupported content-encoding ${encoding}`);
  }
}

/**
 * @brief 请求头里的 key（Authorization 的 Bearer 值、x-api-key）：只给 capture 把响应体副本里出现的 key 换成 ***，
 *        不存、不打印。
 */
function headerSecrets(headers) {
  const bearer = /^Bearer\s+(.+)$/i.exec(String(headers.authorization ?? ''))?.[1]?.trim();
  return [bearer, headers['x-api-key']].filter((value) => typeof value === 'string' && value.length > 0);
}

/**
 * @brief 记下一次列表请求的结果：{ t, provider, url（原来的地址）, status, auth（带了 Authorization 头）,
 *        body（JSON，不是 JSON 时为文字；出现请求带的 key 时换成 ***） }。
 * @param secrets headerSecrets 的结果（只用来替换）
 */
function capture(proxy, item, raw, { encoding, secrets }) {
  try {
    let text = decoded(raw, encoding).toString('utf8');
    for (const secret of secrets) text = text.split(secret).join('***');
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      // 不是 JSON 的响应（例如 404 的文字）原样存成字符串，同已有的真实录制
      body = text;
    }
    proxy.captures.push({ t: Date.now(), ...item, body });
  } catch (error) {
    proxy.errors.push(`${item.provider} ${item.url}: ${error.message}`);
    console.error(`[md-real-proxy] cannot decode ${item.url}: ${error.message}`);
  }
}

/** @brief 转发一个请求；列表请求的响应体边转发边留一份。 */
function forwardRequest(proxy, { req, res, provider, url }, raw) {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;
  const list = isListRequest(req.method, url);
  const upstream = client.request(target, { method: req.method, headers: { ...req.headers, host: target.host } },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      if (!list) {
        answer.pipe(res);
        return;
      }
      const parts = [];
      answer.on('data', (chunk) => {
        parts.push(chunk);
        res.write(chunk);
      });
      answer.on('end', () => {
        res.end();
        capture(proxy, { provider, url, status: answer.statusCode, auth: Boolean(req.headers.authorization) },
          Buffer.concat(parts), { encoding: answer.headers['content-encoding'], secrets: headerSecrets(req.headers) });
      });
    });
  upstream.on('error', (error) => {
    proxy.errors.push(`${provider} ${target.pathname}: ${error.message}`);
    console.error(`[md-real-proxy] ${provider} ${target.pathname}: ${error.message}`);
    res.destroy();
  });
  res.on('close', () => upstream.destroy());
  upstream.end(raw);
}

/**
 * @brief 启动转发代理：/p/<id><其余> 原样转发到 routes[id] + <其余>；其他路径（例如 §3.3 第 6 步发往代理 origin 的
 *        请求）回 404，不转发。
 * @param port 端口（真实层的 4880–4889）
 * @param routes 提供商 id → 原来的 origin
 * @return { port, captures, errors, server }
 */
export function startListProxy(port, routes) {
  const proxy = { port, captures: [], errors: [], server: null };
  proxy.server = http.createServer((req, res) => {
    const match = /^\/p\/([^/?]+)(.*)$/.exec(req.url ?? '');
    const origin = match ? routes[match[1]] : undefined;
    if (!origin) {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => forwardRequest(proxy, { req, res, provider: match[1], url: `${origin}${match[2]}` },
      Buffer.concat(chunks)));
  });
  return new Promise((done, fail) => {
    proxy.server.once('error', fail);
    proxy.server.listen(port, '127.0.0.1', () => done(proxy));
  });
}

/** @brief 关掉转发代理（断开全部连接，端口不再监听）。 */
export function stopListProxy(proxy) {
  proxy?.server?.closeAllConnections?.();
  proxy?.server?.close();
}

/**
 * @brief 一次录下的列表响应的文件内容（同 bodies/ 里已有的真实录制：source、recorded、url、note、status、body；
 *        不存请求头和响应头）。
 */
export const bodyEnvelope = (item, note) => ({ source: 'real', recorded: localDate(item.t), url: item.url, note,
  status: item.status, body: item.body });

// ---------- 页面里的录制器 ----------

/**
 * @brief 在页面里装录制器（page.evaluate 执行；录制格式同 md-record.mjs 与 tests/ui/harness/replay.js：{ t, command }、
 *        { t, result: { type, value } }、{ t, envelope }、{ t, note, command }，t 从 begin 起算）。begin 到 end 之间记下
 *        录制器自己发的命令与结果（一条接一条，不交错）和后台进程转发的全部事件；界面自己发的写命令录不到，由
 *        recUiCommand 记成 { note, command }。
 *        不论录不录，都留下最新的 mori.profiles 信封（profiles）与每个模型最近一次出现在 running 里的时刻（ran）。
 */
export function installRecorder() {
  if (window.__mdReal) return;
  const rec = {
    profiles: null, ran: {}, steps: [], t0: performance.now(), recording: false, chain: Promise.resolve(),
    log(entry) {
      if (this.recording) this.steps.push({ t: Math.round(performance.now() - this.t0), ...entry });
    },
    begin() {
      this.steps = [];
      this.t0 = performance.now();
      this.recording = true;
    },
    end() {
      this.recording = false;
      return this.steps;
    },
    cmd(command) {
      const send = async () => {
        this.log({ command });
        try {
          const value = await window.mori.request(command);
          this.log({ result: { type: command.type, value } });
          return value;
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
  window.mori.onEvent((envelope) => {
    rec.log({ envelope });
    if (envelope.sessionId !== null || envelope.event?.type !== 'mori.profiles') return;
    rec.profiles = envelope;
    for (const item of envelope.event.running) rec.ran[item.ref] = Date.now();
  });
  window.__mdReal = rec;
}

/** @brief 开始录一份 fixture（清掉之前的步骤）。 */
export const recBegin = (page) => page.evaluate(() => window.__mdReal.begin());
/** @brief 录制器发一条命令（经 window.mori.request），返回结果。 */
export const recCmd = (page, command) => page.evaluate((item) => window.__mdReal.cmd(item), command);
/**
 * @brief 记下界面自己发的一条写命令：{ t, note, command }，没有 result（window.mori 是冻结的，录制器录不到界面的命令）。
 *        command 由调用方按界面的操作写出，并在之后按配置的变化核对（不符合时 fixture 写到 rejected）；回放桥按它数
 *        录制里写命令的条数（tests/ui/harness/replay.js 的 modelsResult），之后录下的 models.get 配给界面加入之后的设置页。
 */
export const recUiCommand = (page, command, note) => page.evaluate((entry) => window.__mdReal.log(entry),
  { note, command });
/** @brief 停止录制，返回这份 fixture 的步骤。 */
export const recEnd = (page) => page.evaluate(() => window.__mdReal.end());
/** 开头的命令：像界面启动时读会话列表与设置、再像进入设置页时读 config.get 与 models.get（同 md-record.mjs） */
export const OPENING = [{ type: 'session.list' }, { type: 'config.get' }, { type: 'config.get' },
  { type: 'models.get' }];

/** @brief 经进程桥读 models.get（只读查询）。 */
export const modelsGet = (page) => page.evaluate(() => window.mori.request({ type: 'models.get' }));

/**
 * @brief 等 ref 的探针跑完：since 之后出现在 running 里，现在不在 running 里，档案不是 probing。
 * @return 跑完为 true，超时为 false
 */
export function waitProbed(page, ref, since, timeout) {
  return page.waitForFunction(({ model, from }) => {
    const rec = window.__mdReal;
    const profile = rec?.profiles?.event.profiles[model];
    return Boolean(profile && profile.status !== 'probing' && (rec.ran[model] ?? 0) >= from
      && !rec.profiles.event.running.some((item) => item.ref === model));
  }, { model: ref, from: since }, { timeout, polling: 1000 }).then(() => true, () => false);
}

// ---------- 界面 ----------

/** @brief 提供商卡。 */
export const cardOf = (page, id) => page.locator(`[data-testid="provider-card"][data-provider="${attr(id)}"]`);
/** @brief 清单的一行。 */
export const rowOf = (scope, id) => scope.locator(`[data-testid="discovered-row"][data-model="${attr(id)}"]`);
/** @brief 模型行。 */
export const modelRowOf = (scope, ref) => scope.locator(`[data-testid="model-row"][data-model="${attr(ref)}"]`);

/** 拉取结束时出现的东西：清单、列表错误、命令出错的原文，或已取消 */
const FETCHED = ['[data-testid="checklist"]', '[data-testid="list-error"]', '[data-testid="form-message"]',
  '[data-testid="fetch-status"][data-state="cancelled"]'].join(', ');

/**
 * @brief 一次读出 scope（提供商卡或 Add provider 表单）里拉取之后的状态：清单与标题、列表错误、命令出错的原文、
 *        已取消、Detected 一行、Not listed 一行、Base URL 的说明、过滤框、截断说明、Add 按钮与 Fetch models 按钮。
 */
export function fetchedState(scope) {
  return scope.evaluate((root) => {
    const one = (css) => root.querySelector(css);
    const text = (css) => one(css)?.textContent ?? null;
    const error = one('[data-testid="list-error"]');
    const detected = one('[data-testid="detected-server"]');
    const add = one('[data-action="add-models"]');
    return { checklist: Boolean(one('[data-testid="checklist"]')), title: text('[data-testid="checklist"] h4'),
      listError: error ? { kind: error.dataset.kind, text: error.textContent } : null,
      commandError: text('[data-testid="form-message"]'),
      cancelled: Boolean(one('[data-testid="fetch-status"][data-state="cancelled"]')),
      detected: detected ? { kind: detected.dataset.kind, text: detected.textContent } : null,
      notListed: text('[data-testid="not-listed"]'), baseUrlNote: text('[data-testid="base-url-note"]'),
      filter: Boolean(one('[data-testid="checklist-filter"]')),
      truncated: Boolean(one('[data-testid="checklist-truncated"]')),
      add: add ? { text: add.textContent, disabled: add.disabled } : null,
      fetch: [...root.querySelectorAll('[data-action="fetch-models"]')].map((b) => ({ text: b.textContent,
        disabled: b.disabled })) };
  });
}

/**
 * @brief 点了 Fetch models 之后等拉取结束（FETCHED 之一出现），返回 fetchedState。
 * @param timeout 毫秒；列表请求每个 15 秒、最多 3 次（§11），再加界面的时间
 */
export async function waitFetched(scope, timeout = 90000) {
  await scope.locator(FETCHED).first().waitFor({ timeout });
  return fetchedState(scope);
}

/**
 * @brief 清单（或列表错误下手填的行）里显示着的每一行：id、data-chat、Added、不能加入、勾选与能不能勾、两个数字框的值、
 *        两个勾选框、Not reported 的字段、标记与提示。
 */
export function readRows(scope) {
  return scope.locator('[data-testid="discovered-row"]').evaluateAll((rows) => rows.map((row) => {
    const box = (field) => row.querySelector(`input[data-field="${field}"]`);
    const pick = row.querySelector('input[name="pick"]');
    const kinds = (css, key) => [...row.querySelectorAll(css)].map((el) => el.dataset[key]);
    return { id: row.dataset.model, chat: row.dataset.chat, added: row.dataset.added === 'true',
      unusable: row.dataset.unusable === 'true', picked: pick?.checked ?? false,
      pickable: pick ? !pick.disabled : false,
      contextWindow: box('contextWindow')?.value ?? null, maxTokens: box('maxTokens')?.value ?? null,
      reasoning: box('reasoning')?.checked ?? null, image: box('image')?.checked ?? null,
      notReported: kinds('[data-testid="not-reported"]', 'field'), tags: kinds('[data-testid="row-tag"]', 'kind'),
      hints: kinds('[data-testid="row-hint"]', 'kind') };
  }));
}

/** @brief 一个模型行此刻的样子：Tool calling 的 data-value、提示（kind 与文字）、(not reported) 的字段。 */
export function modelRowState(row) {
  return row.evaluate((el) => ({ tool: el.querySelector('[data-field="tool_calling"]')?.dataset.value ?? null,
    hints: [...el.querySelectorAll('[data-testid="model-hint"]')].map((hint) => ({ kind: hint.dataset.kind,
      text: hint.querySelector('span')?.textContent ?? hint.textContent })),
    notReported: [...el.querySelectorAll('[data-testid="not-reported"]')].map((item) => item.dataset.field) }));
}

/** @brief Add a model ID：填 id、点 Add to list（§6.4）。 */
export async function addModelId(scope, id) {
  const line = scope.getByTestId('manual-model');
  await line.locator('input[data-field="id"]').fill(id);
  await line.locator('[data-action="add-to-list"]').click();
}

/** @brief Add a model ID 一行此刻的样子（§6.4）：输入框的文字、字段错误的原文（没有时为 null）、Add to list 不可用。 */
export function manualState(scope) {
  return scope.getByTestId('manual-model').evaluate((line) => ({
    text: line.querySelector('input[data-field="id"]')?.value ?? null,
    error: line.querySelector('[data-testid="field-error"][data-field="id"]')?.textContent ?? null,
    blocked: line.querySelector('[data-action="add-to-list"]')?.disabled ?? null }));
}

/**
 * @brief scope 里有清单行，并且每一行在文档顺序上都在 css 指的元素之后（列表错误时手填的行列在错误下面，§6.3）；
 *        没有那个元素或没有行时为 false。
 */
export function rowsFollow(scope, css) {
  return scope.evaluate((root, selector) => {
    const anchor = root.querySelector(selector);
    const rows = [...root.querySelectorAll('[data-testid="discovered-row"]')];
    return Boolean(anchor) && rows.length > 0 && rows.every((row) => Boolean(anchor.compareDocumentPosition(row)
      & Node.DOCUMENT_POSITION_FOLLOWING));
  }, css);
}

/** @brief 清单开着时只勾 id 这一行：先 Clear selection（只作用于显示着的、能勾的行），再勾它。 */
export async function pickOnly(scope, id) {
  const clear = scope.locator('[data-action="clear-selection"]');
  if (await clear.count()) await clear.click();
  await rowOf(scope, id).locator('input[name="pick"]').check();
}

/**
 * @brief 等 root 里某个 css 指的元素的文字匹配 pattern，最多 timeout 毫秒（例如首次启动表单下方测试连接的结果）。
 * @return 匹配的文字；超时为 null
 */
export function waitText(page, { root, css, pattern }, timeout) {
  return page.waitForFunction(({ scope, selector, source }) => {
    const items = [...(document.querySelector(scope)?.querySelectorAll(selector) ?? [])];
    return items.map((item) => item.textContent).find((text) => new RegExp(source).test(text)) ?? false;
  }, { scope: root, selector: css, source: pattern.source }, { timeout, polling: 250 })
    .then((handle) => handle.jsonValue(), () => null);
}

/** @brief 首次启动表单下方的探针状态（first-run.md“探针状态”）：data-state 与文字；没有时为 null。 */
export const probeStatus = (page) => page.evaluate(() => {
  const status = document.querySelector('[data-testid="probe-status"]');
  return status ? { state: status.dataset.state, text: status.textContent } : null;
});

/** @brief 等 scope 里出现 ref 的模型行（加入成功后）。 */
export const waitModelRow = (scope, ref, timeout = 60000) => modelRowOf(scope, ref).waitFor({ timeout });

/** @brief 设置页里所有提供商卡的 id，按显示顺序。 */
export const cardIds = (page) => page.locator('[data-testid="provider-card"]')
  .evaluateAll((cards) => cards.map((card) => card.dataset.provider));

/** @brief 等 test() 对 read() 的结果成立，最多 timeout 毫秒；返回最后一次读到的值。 */
export async function pollFor(read, test, timeout = 5000, step = 200) {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!test(value) && Date.now() < deadline) {
    await sleep(step);
    value = await read();
  }
  return value;
}
