// 界面测试用的回放进程桥：代替 preload 提供 window.mori，回放 tests/fixtures/ 里录下的命令与事件（m1–m6、v1、tb 从真实会话
// 录下；mem 从真实的 App 对合成端点录下，source 为 synthetic，记忆规格 §0 第 4 条）。
// 界面发出的每条命令都要与录制时的下一条命令一致（类型、送达方式、文字、批准的选择、文件夹、会话文件、信任回答、
// 名字），否则记为不一致并拒绝；一致时按录制的时间间隔（可加速）发出这条命令之后、下一条命令之前的事件，
// 并在录制时的位置回复结果。
// 只读的查询不占顺序，用录制里的结果回答：session.state（录制时这一刻之后的第一个结果）、session.list（界面所在这一段
// 及之前录下的最后一个结果；开头那个即启动时的列表）、trust.check（同一文件夹按顺序取录制的结果；没录过时"不用问"）。
// 界面发过的查询记在 status.queries：接上还在后台进程里的会话时不该问信任，回放桥不会拒绝多出的 trust.check，
// 由测试检查这里没有它。
// 只用于测试，不在 src/ 中。
// 任务栏闪烁、F8 和删除会话文件不经过后台进程：这里只记下调用，截图和保存的结果由测试通过 window.__replay.f8 控制。
// M4：文件阅读器读文件按录制里的 file 步骤回答（同一个文件按录下的顺序，取完后重复最后一个）；用系统编辑器打开、复制、
// 保存反馈只记下调用，保存反馈的失败与延迟由测试通过 window.__replay.feedback 控制。session.prompt 还比较 refs。
// M5：会话引用读原会话（session.read）也是只读查询，同一个会话文件按录制顺序取结果，取完后重复最后一个。
// M6：config.get、tools.get、agents.get、session.commands 也是只读查询，按 session.list 的做法取界面所在这一段（或更早）录下的
// 最后一个结果；没录过时 config.get 用 synthetic 的连接（下面 m6Config），其余给空结果。新命令（换模型、思考强度、设置页、
// 工具页的写入）都要与录制一致。M1–M5 的录制里会话信息没有思考强度，按后台进程对不支持思考的模型的取值补上（synthetic）。
// 录制里有一次重启（{ restart: true }）时，options.part 选重启前（before）或重启后（after）的一段回放，页面重新载入
// 就是重启。保存反馈、保存报告返回录下的文件路径；设置页 UI issues（记忆规格 §10.8，原 M7 工作回顾的界面问题部分）读报告、
// 读截图按录制里的 issueList、shot 步骤回答（issuesStubs）；导出、在资源管理器里选中、打开文件夹只记下调用。
// v1（docs/specs/model-providers.md §14.4）：models.get、session.pickOptions 也是只读查询，录制里没有时按 fixture.model 合成
// （一个本机区域的提供商、一个模型、normalDefault 为它、档案已验证，synthetic）；会话信息与 mori.model_state 缺的 ModelState
// 字段（pick、current、blocked）同样合成；models.* 的写命令照 connection.save 的方式应答（status.modelWrites 记下）；
// config.get 补上 v1 的 firstRun 等字段。
// 平行 Agent（docs/specs/parallel-agents-taskboard.md §17.4）：board.get 也是只读查询，录制里没有时合成一个空的 TaskBoard；
// 会话信息与接上时的快照缺的协作字段（team、board、teamApprovals、deciding）按没有角色文件、没用过协作模式的会话合成，
// session.clearQueue 的结果缺的 texts 按插话、排队合成（都是 synthetic）；session.prompt 还比较 team。
// 记忆（docs/specs/memory.md §8、§14.4）：memory.list、memory.get、memory.revisions、enhance.get 也是只读查询，但不用
// latestResult，按参数配对（结果配给它之前最近一条同类型命令，同 trustResults/readResult）：memory.list 按（cwd, layer,
// kind），memory.get 按（cwd, layer, id），memory.revisions 按（cwd, layer, id；没有 id 是另一个键），enhance.get 按 cwd；
// 在参数相同、录在当前这一段结束之前的结果里，取回放时刻当时或之后录下的第一个（同 session.state），没有时取其中最后
// 一个；都没有时合成空结果（synthetic，keyedEmpty）。会话信息缺的 memoryNotice 按 null 补上；agents.get 的旧录制缺的
// userTokens、total 按录下的内容补上（withAgentTokens，synthetic）。
// 思考关不掉的模型（docs/specs/model-providers.md §7.7，2026-10-24）：EnhanceInfo 多了 noOffPicks，之前录下的 enhance.get
// 结果与 enhance.set 结果里的 info 没有它时补成 []（withNoOffPicks，synthetic，同 M6_INFO；记忆规格 §8 的 2026-10-24 注）。
// 一键拉取模型（docs/specs/model-discovery.md §13.4）：models.discover 也是只读查询，按参数配对（KEYED，同记忆的查询）：
// 新提供商按（kind, 去掉首尾空白的 baseUrl, api），已有提供商按（kind, providerId）；keySecret 不参与配对（录制里从不带
// key，回放时你填的 key 不影响用哪一次录下的结果）；没录过时合成一个命令失败的结果（synthetic，discoverMissing）。
// models.addModels 照其他 models.* 写命令应答（v1ModelWrite，status.modelWrites 记下）；models.discoverCancel 应答
// { error: null }，记在 status.discoverCancels，不算写命令。models.get、models.reload 录制里有时先用录制的：在界面所在
// 这一段（及之前）录下的结果里，取"录制里它之前的 models.* 写命令条数"不超过界面已发的写命令条数（status.modelWrites）
// 的最后一个（modelsResult）；录制里没有写命令时就是原来的这一段最后一个结果，都没有时才按 fixture.model 合成。
// m6-replay.mjs 从这里读只读查询的列表（QUERIES）；tb-replay.mjs、v1-models-replay.mjs 按文字读那一行。

/** 截图返回的 1×1 PNG */
const PIXEL = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** synthetic：M3 才加进会话信息的字段，M1/M2 录制里没有时按后台进程对没有项目资源的文件夹的取值补上 */
const M3_INFO = { name: null, projectTrust: 'none', trustRemembered: false, trustSaveError: null, extensionErrors: [],
  extensionNotices: [] };

/**
 * @brief synthetic：M1 录下的 session.create / session.open 结果里还没有批准设置（M2 才加），按后台进程对新会话的
 *        默认值（每次询问、没有已允许的工具）补上；M3 的字段同样按 M3_INFO 补上；平行 Agent 的协作字段按 TEAM_INFO
 *        补上（会话信息和接上时的快照 live 都补）；记忆规格 §9.9 的 memoryNotice 按 null 补上（没有待显示的提示）。
 *        session.clearQueue 的结果没有 texts 时按插话、排队拼出。enhance.set 结果里的 info 没有 noOffPicks 时补成 []
 *        （withNoOffPicks）。新录的原样返回。
 */
function withDefaults(type, value, fixture) {
  if (type === 'enhance.set') return withNoOffPicks(type, value);
  if (type === 'session.clearQueue' && value && !('texts' in value)) {
    return { ...value, texts: [...value.steering, ...value.followUp] };
  }
  if ((type !== 'session.create' && type !== 'session.open' && type !== 'session.recheckAgents') || !value) {
    return value;
  }
  const live = value.live ? { ...teamInfo(), ...value.live } : value.live;
  return { ...M3_INFO, approval: { mode: 'ask', allowed: [] }, ...M6_INFO, ...v1ModelState(fixture, value),
    ...teamInfo(), memoryNotice: null, ...value, ...(live === undefined ? {} : { live }) };
}

/**
 * @brief synthetic：平行 Agent 规格 §13.10 加进会话信息与快照的字段，v0、v1 模型层的录制里没有：按后台进程对没有角色文件、
 *        没用过协作模式的会话的取值（关闭模式、基座持有三项权限、没有角色、没有后台 Agent、空的 TaskBoard）。
 */
function teamInfo() {
  return { team: { mode: 'off', holders: { dialog: 'mori', create: 'mori', close: 'mori' }, roles: [], busy: false,
    background: false }, board: emptyBoard(), teamApprovals: [],
    deciding: { role: 'mori', since: null, queue: [] } };
}

/** @brief synthetic：没有需求的 TaskBoard 视图（board.get 没录过时的结果，与 shared/team.ts emptyBoard 相同）。 */
function emptyBoard() {
  return { requests: [], teamEdited: false };
}

/** @brief synthetic：没录过的 M6 只读查询的空结果（agents.get 的 token 数由 withAgentTokens 补上）。 */
function m6Empty(type) {
  if (type === 'session.commands') return [];
  if (type === 'agents.get') return { userPath: 'replay\\AGENTS.md', content: null, effectivePath: null, loaded: null };
  return { cwd: null, projectTrust: null, tools: null, skills: [], packages: [], mcp: null, diagnostics: [] };
}

// ---------- 记忆（docs/specs/memory.md §8、§10.3、§14.4）：旧录制没有的，按后台进程的取法合成（synthetic） ----------

/** 中日韩字符的码点范围（同 src/shared/memory.ts 的 CJK_RANGES，§6.3） */
const CJK_RANGES = [[0x3000, 0x303f], [0x3040, 0x30ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xac00, 0xd7af],
  [0xf900, 0xfaff], [0xff00, 0xffef]];

/** @brief §6.3 的 token 估算（同 src/shared/memory.ts estimateMemoryTokens）：中日韩字符每个 1，其余 ÷ 4 向上取整。 */
function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (CJK_RANGES.some(([low, high]) => code >= low && code <= high)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/**
 * @brief synthetic：记忆规格 §10.3 给 agents.get 加的 token 数，旧录制与 m6Empty 里没有：userTokens 按录下的 content 估算
 *        （content 为 null 时 0），total 等于 userTokens，loaded 里的字符串补为 { path, tokens: 0 }。新录的原样返回。
 */
function withAgentTokens(value) {
  if (!value || ('userTokens' in value && 'total' in value)) return value;
  const userTokens = typeof value.content === 'string' ? estimateTokens(value.content) : 0;
  const loaded = Array.isArray(value.loaded)
    ? value.loaded.map((item) => (typeof item === 'string' ? { path: item, tokens: 0 } : item)) : value.loaded;
  return { ...value, loaded, userTokens, total: userTokens };
}

/**
 * @brief models.discover 配对的键（model-discovery.md §5.1、§13.4）：新提供商为（kind, 去掉首尾空白的 baseUrl, api），
 *        已有提供商为（kind, providerId）；keySecret 不参与配对。
 */
function discoverKey(command) {
  const { target } = command;
  return target?.kind === 'provider' ? ['provider', target.providerId]
    : ['new', String(target?.baseUrl ?? '').trim(), target?.api ?? null];
}

/** 按参数配对的只读查询（§8；models.discover 见 discoverKey）：命令类型 → 配对的键（参数的列表） */
const KEYED = {
  'memory.list': (command) => [command.cwd ?? null, command.layer, command.kind],
  'memory.get': (command) => [command.cwd ?? null, command.layer, command.id],
  'memory.revisions': (command) => [command.cwd ?? null, command.layer, command.id ?? null],
  'enhance.get': (command) => [command.cwd ?? null],
  'models.discover': discoverKey,
};

/**
 * @brief synthetic：录制里没有这个地址（或提供商）的 models.discover 时的结果：命令本身失败（DiscoverResult 的 error，
 *        model-discovery.md §5.2），其余为空。测试不该用到。
 */
function discoverMissing(command) {
  return { error: `Synthetic: no recorded models.discover for ${JSON.stringify(discoverKey(command))}`,
    cancelled: false, server: null, api: 'openai-completions', baseUrl: '', name: '', anthropicShape: false,
    listError: null, models: [], truncated: false, notListed: [] };
}

/** @brief synthetic：关着、没有运行过的增强（后台进程对没有 enhance.json 的项目的 enhance.get 结果）。 */
function enhanceOff(cwd) {
  return { cwd: cwd ?? '', enabled: false, pick: null, thinking: 'medium', team: false, time: '04:00', since: null,
    last: { taste: null, strategy: null, review: null }, running: null, queued: 0, next: null, notice: null,
    effortPicks: {}, noOffPicks: [], error: null };
}

/**
 * @brief synthetic（同 M6_INFO 的做法）：EnhanceInfo.noOffPicks 是 2026-10-24 加的（模型层规格 §7.7；记忆规格 §8 的
 *        2026-10-24 注），之前录下的 enhance.get 结果与 enhance.set 结果里的 info 没有它，按"没有思考关不掉的模型"补成 []；
 *        effortPicks 不变，录下的 fixture 照样有效。新录的（已有 noOffPicks）原样返回。
 */
function withNoOffPicks(type, value) {
  if (type === 'enhance.get' && value && !('noOffPicks' in value)) return { ...value, noOffPicks: [] };
  if (type === 'enhance.set' && value?.info && !('noOffPicks' in value.info)) {
    return { ...value, info: { ...value.info, noOffPicks: [] } };
  }
  return value;
}

/** @brief synthetic：按参数配对的只读查询录制里没有时的空结果（§8）。 */
function keyedEmpty(command) {
  switch (command.type) {
    case 'memory.list':
      return { entries: [], usage: { used: 0, limit: 500, user: 0, project: 0 }, broken: [], last: null, error: null };
    case 'memory.get': return { entry: null, revisions: [], backlinks: [], error: null };
    case 'memory.revisions':
      return command.id === undefined || command.id === null ? { revisions: [], error: null }
        : { revision: null, error: null };
    case 'models.discover': return discoverMissing(command);
    default: return enhanceOff(command.cwd);
  }
}

/** @brief 后台进程退出后请求得到的错误，原文同 src/preload/index.ts。 */
const crashed = (code) => new Error(`Mori’s background process crashed (exit code ${code})`);

/** synthetic：M6 才加进会话信息的字段，按后台进程对没标"Supports thinking"的模型的取值 */
const M6_INFO = { thinkingLevel: 'off', thinkingLevels: ['off'], reasoning: false };

// ---------- v1 模型层（docs/specs/model-providers.md §14.4）：v0 的录制里没有的，按 fixture.model 合成（synthetic） ----------

/** synthetic：v0 录制没有 model 字段时（例如 m6/pi-config-toggles）用的模型全名 */
const FALLBACK_MODEL = 'mori-endpoint/replay-model';

/**
 * @brief synthetic：v1 的 ModelState 字段（规格 §9.5）。v0 的会话信息与 mori.model_state 只有 model（会话用的模型）：
 *        范围 pick 取录制的模型（新会话的范围就是首次启动写下的 normalDefault，即这个模型），当前模型 current 取 model，
 *        可以发送（blocked 为 null）。录制里已有 pick 时（v1 的录制）原样不动。
 */
function v1ModelState(fixture, value) {
  if (!value || 'pick' in value) return {};
  const model = fixture.model ?? FALLBACK_MODEL;
  return { pick: model, current: value.model ?? model, blocked: null };
}

/**
 * @brief synthetic：models.get 的结果（规格 §9.5），录制里没有时按 fixture.model 合成：一个本机区域的提供商、一个模型、
 *        normalDefault 为它、档案已验证；一个 key（只有 ref 与 label）。keys 由 models.addKey / removeKey 的应答更新
 *        （state.keys），界面写命令之后重新读到的就是改过的样子。档案带上模型行读的 reported（null：没有报告值，不标
 *        "(default)"）与 reasoning.off_refused（false），同 ProfileView（2026-10-26 WP-02：模型行只读这几项；WP-04：
 *        ProfileView 去掉 context.truncation 与 cancel_verified）。
 * @param state 回放桥里合成的设置状态：keys、nextKeyNumber、projects
 */
function v1ModelsInfo(fixture, contextWindow, state) {
  const ref = fixture.model ?? FALLBACK_MODEL;
  const [provider, id] = [ref.slice(0, ref.indexOf('/')), ref.slice(ref.indexOf('/') + 1)];
  const step = (outcome) => ({ outcome, detail: null });
  const profile = { status: 'ready', error: null, server: { kind: 'unknown', version: 'unknown' },
    tool_calling: { state: 'verified', call: step('pass'), result: step('pass') },
    tier: { level: 'A', a: step('pass'), b: step('pass'), c: step('not_run') }, protocol_write: 'verified',
    structured_output: 'verified', vision: 'failed',
    reasoning: { field: 'none', can_disable: 'unknown', replay: 'not_required', off_refused: false },
    context: { declared: contextWindow, reported: null, effective: contextWindow }, reported: null, probedAt: 0,
    suite: 1 };
  const model = { id, family: '', contextWindow, maxTokens: Math.min(16384, Math.floor(contextWindow / 2)),
    reasoning: false, input: ['text'] };
  const config = { version: 1, providers: [{ id: provider, name: 'replay', api: 'openai-completions',
    baseUrl: fixture.endpoint ?? 'http://127.0.0.1:9/v1', compat: {}, concurrency: 4, zone: 'local',
    keys: state.keys.map((key) => ({ ...key })), nextKeyNumber: state.nextKeyNumber, models: [model] }], groups: [],
  normalDefault: ref, allowedZones: ['local', 'intranet'], projectZones: {} };
  return { error: null, config, profiles: { [ref]: profile }, keyStatus: {}, thinkingDefaults: { [ref]: null },
    zoneSuggestions: { [provider]: 'local' }, migration: null, projects: state.projects.map((path) => ({ path,
      zones: [], projectZones: null, projectConfig: null })), loadError: null, reserved: ['mori'] };
}

/** @brief synthetic：session.pickOptions 的结果，录制里没有时按 fixture.model 合成：这个提供商和它的模型，都可用。 */
function v1PickOptions(fixture) {
  const ref = fixture.model ?? FALLBACK_MODEL;
  const provider = ref.slice(0, ref.indexOf('/'));
  const item = (pick, kind, label) => ({ pick, kind, label, zones: ['local'], excluded: false, reason: null });
  return { error: null, options: [item(provider, 'provider', 'replay'),
    item(ref, 'model', ref.slice(ref.indexOf('/') + 1))] };
}

/**
 * @brief synthetic：v1 的 config.get 只有 { agentDir, settingsError, defaultThinkingLevel, firstRun, migrationError,
 *        configError, migratedNow }（规格 §9.4）。v0 录下的结果补上后四项（已有配置、没有迁移）；多出的 v0 字段界面不读。
 */
function v1Config(value) {
  return { settingsError: null, defaultThinkingLevel: 'medium', firstRun: false, migrationError: null,
    configError: null, migratedNow: false, ...value };
}

/**
 * @brief synthetic：models.* 的写命令照 connection.save 的方式应答（不占回放顺序，结果没有错误；含一键拉取模型的
 *        models.addModels，model-discovery.md §13.4）。models.addKey 与 models.removeKey 改合成的 keys，之后的
 *        models.get 读到改过的样子；其余写命令只记下。
 */
function v1ModelWrite(command, state) {
  state.writes.push(command);
  if (command.type === 'models.addKey') {
    const ref = `${command.providerId}#${state.nextKeyNumber}`;
    state.nextKeyNumber += 1;
    state.keys.push({ ref, label: command.label });
    return { error: null, ref };
  }
  if (command.type === 'models.removeKey') state.keys = state.keys.filter((key) => key.ref !== command.ref);
  if (command.type === 'models.saveProvider' || command.type === 'models.firstRun') {
    return { error: null, providerId: command.id ?? command.providerId ?? 'replay' };
  }
  if (/^models\.delete/.test(command.type)) return { error: null, consequences: [] };
  return { error: null };
}

/**
 * @brief synthetic：M1–M5 的录制里没有 config.get 的结果，按录制的端点和模型拼出一个连接（与后台进程的写法相同：
 *        provider id mori-endpoint，一个不支持思考的模型，它是默认模型）。
 */
function m6Config(fixture, saved) {
  const [provider, id] = fixture.model.split('/');
  const { apiKey: _key, modelId: _id, contextWindow, reasoning: _r, thinkingLevel: _t, ...endpoint } = saved.connection;
  const model = { id, contextWindow, reasoning: false, thinkingLevel: 'off', thinkingLevels: ['off'] };
  return { agentDir: 'replay', saved, connections: [{ providerId: provider, endpoint: { ...endpoint, apiKey: '' },
    keySaved: true, models: [model] }], defaultModel: fixture.model,
  models: [{ ref: fixture.model, provider, id, providerName: endpoint.name }], modelsError: null };
}

/**
 * @brief synthetic：M1/M2 录下的 mori.prompt_error 还没有 running（M3 才加）；那时发出时就失败、没有开始运行，
 *        按 false 补上。新录的原样转发。
 */
function withEventDefaults(envelope, fixture) {
  const { event } = envelope;
  if (event.type === 'mori.model_state') return { ...envelope, event: { ...event, ...v1ModelState(fixture, event) } };
  if (event.type !== 'mori.prompt_error' || 'running' in event) return envelope;
  return { ...envelope, event: { ...event, running: false } };
}

/** @brief 按键名排序后的 JSON（比较 refs：界面和录制器拼对象时键的先后可能不同）。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** @brief 文件的比较形式：相对路径接在工作目录后面，统一反斜杠、不分大小写（与主进程解析后的绝对路径比较）。 */
function fileKey(path, cwd) {
  const absolute = /^[a-zA-Z]:[\\/]/.test(path) ? path : `${cwd.replace(/[\\/]+$/, '')}\\${path}`;
  return absolute.replace(/\//g, '\\').toLowerCase();
}

/**
 * @brief 按录制里的 file 步骤回答 readFile：同一个文件（按主进程解析后的路径）按录下的顺序，取完后重复最后一个。
 *        synthetic：没录过的文件按"File not found"（status 为 missing）回答，测试不该用到。
 * @param steps 回放的步骤（M7 是重启前或重启后的一段）
 */
function fileReader(steps) {
  const reads = steps.filter((step) => step.file).map((step) => step.file);
  const taken = new Map();
  return (path, cwd) => {
    const key = fileKey(path, cwd);
    const matching = reads.filter((read) => read.result.path.toLowerCase() === key);
    const count = taken.get(key) ?? 0;
    taken.set(key, count + 1);
    const pick = matching[Math.min(count, matching.length - 1)];
    return pick ? structuredClone(pick.result) : { status: 'missing', path: key };
  };
}

/** 不占回放顺序的只读查询（m6-replay.mjs 也从这里读；tb-replay.mjs、v1-models-replay.mjs 按文字读这一行） */
export const QUERIES = ['session.state', 'session.list', 'trust.check', 'session.read', 'config.get', 'tools.get',
  'agents.get', 'session.commands', 'models.get', 'session.pickOptions', 'board.get', 'memory.list', 'memory.get',
  'memory.revisions', 'enhance.get', 'models.discover'];

/** @brief models.* 的写命令：回放桥直接应答（v1ModelWrite；models.discoverCancel 另记），不占回放顺序。 */
const answeredWrite = (type) => type.startsWith('models.') && !QUERIES.includes(type);

/** 回放桥照 connection.save 的方式应答的 models.* 写命令（v1ModelWrite；含一键拉取模型的 models.addModels） */
const MODEL_WRITES = new Set(['models.firstRun', 'models.saveProvider', 'models.deleteProvider', 'models.saveModel',
  'models.addModels', 'models.deleteModel', 'models.moveModel', 'models.addKey', 'models.removeKey', 'models.moveKey',
  'models.saveGroup', 'models.deleteGroup', 'models.setDefaults', 'models.setProjectZones', 'models.confirmZone',
  'models.dismissMigration', 'models.verify']);

/**
 * @brief 改配置的 models.* 写命令（界面经 writeModels 发出、之后重新 models.get 的那些）：models.get 按它们在录制里的
 *        条数配给界面（modelsResult）。models.reload 是读取，models.discoverCancel 不写配置，都不算。
 */
const configWrite = (type) => answeredWrite(type) && type !== 'models.reload' && type !== 'models.discoverCancel';

/** @brief 录制里由界面主动发出的命令（只读查询与直接应答的 models.* 写命令除外）的下标。 */
function boundaries(steps) {
  return steps.flatMap((step, index) => (step.command && !QUERIES.includes(step.command.type)
    && !answeredWrite(step.command.type) ? [index] : []));
}

/** @brief 信任回答的比较形式；没带时为空串。 */
function trustText(trust) {
  return trust ? `${trust.trusted}/${trust.remember}` : '';
}

/** @brief 拒绝理由的比较形式：去掉首尾空白，空串等于没写。 */
function reasonText(reason) {
  return reason?.trim() ?? '';
}

/**
 * @brief 两条命令是否一致。
 *        approval.answer、ui.answer 也比较 requestId：界面只能答复回放发出的请求，id 与录制时相同；比较它能发现答错了卡。
 *        ui.answer 的回答（真假、选中的那一项、输入的文字，取消为 null）要完全相同。
 */
function sameCommand(expected, actual) {
  if (expected.type !== actual.type) return false;
  switch (expected.type) {
    case 'session.prompt':
      return expected.text === actual.text && (expected.behavior ?? null) === (actual.behavior ?? null)
        && canonical(expected.refs) === canonical(actual.refs) && (expected.team ?? null) === (actual.team ?? null);
    case 'approval.answer':
      return expected.requestId === actual.requestId && expected.decision === actual.decision
        && reasonText(expected.reason) === reasonText(actual.reason);
    case 'ui.answer':
      return expected.requestId === actual.requestId && expected.value === actual.value;
    case 'approval.setMode':
      return expected.mode === actual.mode;
    case 'approval.forget':
      return expected.toolName === actual.toolName;
    case 'session.create':
      return expected.cwd === actual.cwd && trustText(expected.trust) === trustText(actual.trust);
    case 'session.open':
      return expected.sessionFile === actual.sessionFile && trustText(expected.trust) === trustText(actual.trust);
    case 'session.rename':
      return expected.name === actual.name && (expected.sessionId ?? null) === (actual.sessionId ?? null)
        && (expected.sessionFile ?? null) === (actual.sessionFile ?? null);
    case 'session.close':
      return expected.sessionId === actual.sessionId;
    default:
      return sameM6Command(expected, actual);
  }
}

/** @brief M6 的命令（换模型、思考强度、设置页、工具页的写入）是否一致：除 type 以外的字段全部相同（键的先后不计）。 */
function sameM6Command(expected, actual) {
  const { type: _a, ...rest } = m6Normal(expected);
  const { type: _b, ...other } = m6Normal(actual);
  return canonical(rest) === canonical(other);
}

/**
 * @brief 比较前把等价的写法统一：model.save 不支持思考时思考强度不写进任何文件（不比较）；mcp.save 的条目没写 exposure
 *        等于 direct（后台进程补上），空的 args、env 等于没写。
 */
function m6Normal(command) {
  if (command.type === 'model.save' && !command.model.reasoning) {
    const { thinkingLevel: _level, ...model } = command.model;
    return { ...command, model };
  }
  if (command.type !== 'mcp.save') return command;
  const entry = { exposure: 'direct', ...command.entry };
  if (Array.isArray(entry.args) && entry.args.length === 0) delete entry.args;
  if (entry.env && Object.keys(entry.env).length === 0) delete entry.env;
  return { ...command, entry };
}

/**
 * @brief 录制里主进程保存反馈或报告的结果（文件的完整路径），按顺序；kind 为 feedback 或 issue。
 *        界面保存的第 n 份返回录下的第 n 个路径，F8 的"View in Settings"就按它的文件名选中录下的记录。
 */
function recordedFiles(steps, kind) {
  return steps.filter((step) => step[kind]?.result?.file).map((step) => step[kind].result.file);
}

/** @brief M4：文件阅读器读文件（按录制回答）、用系统编辑器打开、复制：只记下调用。 */
function fileStubs(status, steps) {
  const files = fileReader(steps);
  return {
    readFile(path, cwd) {
      status.reads.push({ path, cwd });
      return Promise.resolve(files(path, cwd));
    },
    openPath(path, cwd) {
      status.opened.push({ path, cwd });
      return Promise.resolve({ error: null, revealed: false });
    },
    copyText(text) {
      status.copied.push(text);
      return Promise.resolve();
    },
  };
}

/**
 * @brief 不经过后台进程的桌面能力（任务栏闪烁、正在生成的会话数、F8 截图与保存、打开所在文件夹、保存反馈）：只记下调用。
 *        返回的 f8、feedback 由测试改写，制造截图失败、保存失败或较慢的截图与保存。
 *        保存的结果：录制里有 issue、feedback 步骤（M7）时是录下的路径，否则（synthetic）是 replay 的路径。
 */
function desktopStubs(status, steps) {
  const f8 = { captureDelayMs: 0, captureError: null, saveDelayMs: 0, saveError: null };
  const feedback = { delayMs: 0, error: null };
  const saved = { issue: recordedFiles(steps, 'issue'), feedback: recordedFiles(steps, 'feedback') };
  const wait = (ms) => (ms ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
  const stubs = {
    requestAttention() {
      status.attention += 1;
      return Promise.resolve();
    },
    // 2026-10-26（docs/v0/screens/window.md）：界面报告给主进程的正在生成的会话数，按顺序记下
    setBusySessions(count) {
      status.busySessions.push(count);
    },
    async captureWindow() {
      status.captures += 1;
      // 截图那一刻报告框在不在页面上：截图里不能有报告框（f8.md 反例）。
      status.dialogAtCapture.push(Boolean(document.querySelector('[data-testid="issue-dialog"]')));
      await wait(f8.captureDelayMs);
      if (f8.captureError) return { captureId: null, dataUrl: null, error: f8.captureError };
      return { captureId: `replay-capture-${status.captures}`, dataUrl: PIXEL, error: null };
    },
    async saveIssue(report) {
      await wait(f8.saveDelayMs);
      if (f8.saveError) throw new Error(f8.saveError);
      status.issues.push(structuredClone(report));
      const count = status.issues.length;
      return { file: saved.issue[count - 1] ?? `C:\\replay\\ui-issues\\replay-${count}.md` };
    },
    showIssueInFolder(file) {
      status.shown.push(file);
      return Promise.resolve();
    },
    deleteSessionFile(file) {
      status.deleted.push(file);
      return Promise.resolve({ deleted: true, error: null });
    },
    async saveFeedback(record) {
      await wait(feedback.delayMs);
      if (feedback.error) throw new Error(feedback.error);
      status.feedback.push(structuredClone(record));
      const count = status.feedback.length;
      return { file: saved.feedback[count - 1] ?? `C:\\replay\\feedback\\replay-${count}.json` };
    },
  };
  return { f8, feedback, stubs: { ...stubs, ...fileStubs(status, steps) } };
}

/**
 * @brief 设置页 UI issues（记忆规格 §10.8，src/preload/index.ts 的 mori:issues-* 那几个调用）。读报告（listIssues）按录制里
 *        issueList 步骤（{ result } 或 { error }）的顺序回答，取完后重复最后一个；读截图（issueShot）按名字取录制里的
 *        shot 步骤，在整个录制里找（截图是 ui-issues 里的同一个 PNG，重启前后不变）。导出、显示导出的文件、在资源管理器里
 *        选中、打开文件夹都没有录过：只记下调用，导出的结果是 replay 的路径（synthetic）。
 *        synthetic：没录过 issueList 时列表为空，没录过的截图读不出来；测试不该用到。
 * @param steps 回放的步骤（重启前或重启后的一段）
 */
function issuesStubs(status, fixture, steps) {
  const lists = steps.filter((step) => step.issueList).map((step) => step.issueList);
  const shots = fixture.steps.filter((step) => step.shot).map((step) => step.shot);
  const answer = (recorded, fallback) => (recorded?.error ? Promise.reject(new Error(recorded.error))
    : Promise.resolve(structuredClone(recorded ? recorded.result : fallback)));
  return {
    listIssues() {
      status.issueLists += 1;
      return answer(lists[Math.min(status.issueLists, lists.length) - 1], []);
    },
    issueShot(name) {
      status.issueShots.push(name);
      const recorded = shots.find((shot) => shot.name === name);
      return recorded ? answer(recorded) : Promise.reject(new Error(`Synthetic: no recorded screenshot ${name}`));
    },
    exportIssues(request) {
      status.exports.push(structuredClone(request));
      return Promise.resolve({ file: `C:\\replay\\export\\replay-${status.exports.length}.md` });
    },
    showExport(file) {
      status.exportShown.push(file);
      return Promise.resolve();
    },
    showIssueRecord(name) {
      status.recordShown.push(name);
      return Promise.resolve();
    },
    openIssuesFolder() {
      status.folders += 1;
      return Promise.resolve({ error: null });
    },
  };
}

/**
 * @brief 重启前（part 为 before）或重启后（after）的步骤；part 为空时是全部（restart 步骤不发事件、不占顺序）。
 *        录制里没有 restart 步骤、或 part 不是这两种时报错。
 */
function partOf(steps, part) {
  if (!part) return steps;
  const at = steps.findIndex((step) => step.restart);
  if (at < 0 || !['before', 'after'].includes(part)) throw new Error(`Cannot replay part ${part} of this fixture`);
  return part === 'before' ? steps.slice(0, at) : steps.slice(at + 1);
}

/**
 * @brief 创建回放进程桥。
 * @param fixture 录制文件内容
 * @param options.speed 加速倍数
 * @param options.maxGap 两个事件之间最多等待的毫秒数（加速后）
 * @param options.part 录制里有重启时：重启前（before）或重启后（after）的一段；不给时回放全部
 */
export function createReplayBridge(fixture, { speed = 1, maxGap = 1500, part = null } = {}) {
  const steps = partOf(fixture.steps, part);
  const marks = boundaries(steps);
  const listeners = { event: new Set(), exit: new Set(), ready: new Set() };
  // played：已经放完的段数（每条命令之后、下一条命令之前算一段）；played 等于 cursor 时回放桥在等界面的下一条命令。
  const status = { cursor: 0, played: 0, clock: 0, exited: false, exitCode: null, errors: [], commands: [], queries: [],
    playing: Promise.resolve(), idle: true, attention: 0, busySessions: [], captures: 0, dialogAtCapture: [],
    issues: [], shown: [], deleted: [], reads: [], opened: [], copied: [], feedback: [], failed: [], issueLists: 0,
    issueShots: [], exports: [], exportShown: [], recordShown: [], folders: 0, modelWrites: [], discoverCancels: 0 };
  const { f8, feedback, stubs } = desktopStubs(status, steps);
  const created = steps.find((step) => step.result?.type === 'session.create')?.result.value;
  // synthetic：v1 的设置页（models.get）读到的 key 与项目；models.addKey / removeKey 的应答改它（v1ModelWrite）
  const models = { keys: [{ ref: `${(fixture.model ?? FALLBACK_MODEL).split('/')[0]}#1`, label: 'Key 1' }],
    nextKeyNumber: 2, projects: created?.cwd ? [created.cwd.replace(/\\/g, '/').toLowerCase()] : [],
    writes: status.modelWrites };
  const saved = { connection: { name: 'replay', baseUrl: fixture.endpoint, api: 'openai-completions', apiKey: '',
    modelId: fixture.model.split('/').pop(), contextWindow: created?.contextUsage?.contextWindow ?? 128000,
    compat: [] }, keySaved: true };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** @brief 回放一段：从 start 到 end（不含），在命令结果的位置 resolve。 */
  async function play(start, end, commandType, resolve) {
    let previous = steps[start].t;
    let resolved = false;
    for (let index = start + 1; index < end; index += 1) {
      if (status.exited) return;
      const step = steps[index];
      const gap = Math.min(maxGap, Math.max(0, (step.t - previous) / speed));
      previous = step.t;
      if (gap > 0) await sleep(gap);
      status.clock = step.t;
      if (step.envelope) {
        for (const listener of listeners.event) listener(withEventDefaults(structuredClone(step.envelope), fixture));
      }
      if (step.result && !resolved && step.result.type === commandType) {
        resolved = true;
        resolve(step.result);
      }
    }
    if (!resolved) resolve({ type: commandType, value: null });
  }

  /** @brief 回答 session.state：录制时在这个时刻之后收到的第一个结果（录制器也是在 turn_end 后请求的）。 */
  function stateResult() {
    const results = steps.filter((step) => step.result?.type === 'session.state');
    const next = results.find((step) => step.t >= status.clock) ?? results.at(-1);
    return next?.result.value ?? { contextUsage: created?.contextUsage ?? null };
  }

  /**
   * @brief 回答 session.list：界面现在所在的这一段（上一条已回放的命令之后、下一条命令之前）里录下的最后一个结果，
   *        这一段没有时取更早的；还没回放任何命令时就是录制开头的那个（启动时的列表）。按段而不按回放时钟取，
   *        界面在一条命令之后马上读列表（例如删除之后）时也能拿到这一段录下的结果。
   */
  function listResult() {
    return latestResult('session.list', []);
  }

  /**
   * @brief 只读查询的结果：界面现在所在的这一段（及之前）录下的最后一个成功结果（M6：config.get、tools.get、agents.get、
   *        session.commands 与 session.list 同样取）；没录过时用 fallback。
   */
  function latestResult(type, fallback) {
    const end = marks[status.cursor] ?? steps.length;
    const found = steps.slice(0, end).filter((step) => step.result?.type === type && !step.result.error);
    return structuredClone(found.at(-1)?.result.value ?? fallback);
  }

  /** 每一步之前录制里改配置的 models.* 写命令条数（configWrite；modelsResult 用） */
  const writesBefore = [];
  steps.reduce((count, step, index) => {
    writesBefore[index] = count;
    return count + (step.command && configWrite(step.command.type) ? 1 : 0);
  }, 0);

  /**
   * @brief 回答 models.get、models.reload（model-discovery.md §13.4：录制里有时先用录制的）：界面所在这一段（及之前）
   *        录下的成功结果里，录制里它之前的写命令条数不超过界面已发的写命令条数的最后一个；没有时用 fallback。
   *        录制里没有写命令时与 latestResult 相同。
   */
  function modelsResult(type, fallback) {
    const end = marks[status.cursor] ?? steps.length;
    const sent = status.modelWrites.filter((command) => configWrite(command.type)).length;
    const found = steps.slice(0, end).filter((step, index) => step.result?.type === type && !step.result.error
      && writesBefore[index] <= sent);
    return structuredClone(found.at(-1)?.result.value ?? fallback);
  }

  /** 按参数配对的只读查询的结果（§8）：{ index, step, key }，key 为它之前最近一条同类型命令的参数 */
  const keyedSteps = steps.flatMap((step, index) => {
    const type = step.result?.type;
    if (!Object.hasOwn(KEYED, type ?? '')) return [];
    const asked = steps.slice(0, index).findLast((item) => item.command?.type === type)?.command;
    return asked ? [{ index, step, key: JSON.stringify(KEYED[type](asked)) }] : [];
  });

  /**
   * @brief 回答按参数配对的只读查询（§8）：参数相同、录在当前这一段结束之前的结果里，取回放时刻当时或之后录下的第一个；
   *        没有时取其中最后一个；都没有时为合成的空结果。录下的是失败时以它的原文失败。
   */
  function keyedResult(command) {
    const end = marks[status.cursor] ?? steps.length;
    const key = JSON.stringify(KEYED[command.type](command));
    const matching = keyedSteps.filter((item) => item.index < end && item.step.result.type === command.type
      && item.key === key);
    const pick = matching.find((item) => item.step.t >= status.clock) ?? matching.at(-1);
    if (!pick) return Promise.resolve(keyedEmpty(command));
    if (pick.step.result.error) return Promise.reject(new Error(pick.step.result.error));
    return Promise.resolve(withNoOffPicks(command.type, structuredClone(pick.step.result.value)));
  }

  /** 每个文件夹已经取走的 trust.check 结果数 */
  const trustTaken = new Map();

  /** @brief 录制里某个文件夹的 trust.check 结果，按顺序。 */
  function trustResults(cwd) {
    return steps.filter((step, index) => step.result?.type === 'trust.check'
      && steps.slice(0, index).reverse().find((s) => s.command?.type === 'trust.check')?.command.cwd === cwd);
  }

  /** @brief 回答 trust.check：同一文件夹按录制顺序取结果，取完后重复最后一个；没录过时"不用问"。 */
  function trustResult(cwd) {
    const recorded = trustResults(cwd);
    const taken = trustTaken.get(cwd) ?? 0;
    trustTaken.set(cwd, taken + 1);
    const step = recorded[Math.min(taken, recorded.length - 1)];
    return structuredClone(step?.result.value ?? { ask: false, readError: null });
  }

  /** 每个会话文件已经取走的 session.read 结果数 */
  const readTaken = new Map();

  /**
   * @brief 回答 session.read：同一会话文件按录制顺序取结果，取完后重复最后一个。
   *        synthetic：没录过的会话文件按"Session file not found: <文件>"回答（与后台进程的原文相同），测试不该用到。
   */
  function readResult(sessionFile) {
    const recorded = steps.filter((step, index) => step.result?.type === 'session.read'
      && steps.slice(0, index).reverse().find((s) => s.command?.type === 'session.read')?.command.sessionFile
        === sessionFile);
    const taken = readTaken.get(sessionFile) ?? 0;
    readTaken.set(sessionFile, taken + 1);
    const step = recorded[Math.min(taken, recorded.length - 1)];
    if (!step || step.result.error) {
      return Promise.reject(new Error(step?.result.error ?? `Session file not found: ${sessionFile}`));
    }
    return Promise.resolve(structuredClone(step.result.value));
  }

  /** @brief 系统选文件夹对话框的结果：下一条命令是 package.add 时是它的文件夹（M6），否则是下一条 session.create 的文件夹。 */
  function nextFolder() {
    const next = marks[status.cursor] === undefined ? null : steps[marks[status.cursor]].command;
    if (next?.type === 'package.add') return next.path;
    const index = marks.slice(status.cursor).find((mark) => steps[mark].command.type === 'session.create');
    return index === undefined ? created?.cwd ?? null : steps[index].command.cwd;
  }

  /** @brief 按录制回放一条界面命令。control.failNext 有值时（synthetic）这一条直接以它失败，不占回放顺序。 */
  function replayCommand(command) {
    if (control.failNext) {
      const message = control.failNext;
      control.failNext = null;
      status.failed.push(command);
      return Promise.reject(new Error(message));
    }
    const index = marks[status.cursor];
    const expected = index === undefined ? null : steps[index].command;
    status.commands.push(command);
    if (!expected || !sameCommand(expected, command)) {
      const message = `replay mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(command)}`;
      status.errors.push(message);
      return Promise.reject(new Error(message));
    }
    status.cursor += 1;
    const end = marks[status.cursor] ?? steps.length;
    return new Promise((resolve, reject) => {
      status.idle = false;
      status.playing = status.playing.then(() => play(index, end, command.type, (result) => {
        if (result.error) reject(new Error(result.error));
        else resolve(withDefaults(command.type, result.value, fixture));
      })).finally(() => {
        status.played += 1;
        status.idle = status.cursor >= marks.length;
      });
    });
  }

  /**
   * @brief 回放桥直接回答的 models.* 命令（不占回放顺序）：读取（models.get、models.reload 按 modelsResult）、
   *        拉取（models.discover 按参数配对，model-discovery.md §13.4）、取消拉取与写命令（v1ModelWrite）；
   *        别的命令为 null。
   */
  function modelsAnswer(command) {
    switch (command.type) {
      case 'models.get':
      case 'models.reload':
        status.queries.push(command);
        return Promise.resolve(modelsResult(command.type, v1ModelsInfo(fixture,
          created?.contextUsage?.contextWindow ?? 128000, models)));
      case 'models.discover':
        status.queries.push(command);
        return keyedResult(command);
      case 'models.discoverCancel':
        status.discoverCancels += 1;
        return Promise.resolve({ error: null });
      default:
        return MODEL_WRITES.has(command.type) ? Promise.resolve(v1ModelWrite(command, models)) : null;
    }
  }

  const bridge = {
    request(command) {
      if (status.exited) return Promise.reject(crashed(status.exitCode));
      const answered = modelsAnswer(command);
      if (answered) return answered;
      switch (command.type) {
        case 'config.get': return Promise.resolve(v1Config(latestResult('config.get', m6Config(fixture, saved))));
        case 'session.pickOptions':
          status.queries.push(command);
          return Promise.resolve(latestResult(command.type, v1PickOptions(fixture)));
        case 'board.get':
          // synthetic：录制里没有 board.get 时是空的 TaskBoard（没用过协作模式的会话）
          status.queries.push(command);
          return Promise.resolve(latestResult(command.type, { ...emptyBoard(), error: null }));
        case 'tools.get':
        case 'session.commands':
          status.queries.push(command);
          return Promise.resolve(latestResult(command.type, m6Empty(command.type)));
        case 'agents.get':
          status.queries.push(command);
          return Promise.resolve(withAgentTokens(latestResult(command.type, m6Empty(command.type))));
        case 'memory.list': case 'memory.get': case 'memory.revisions': case 'enhance.get':
          status.queries.push(command);
          return keyedResult(command);
        case 'connection.save': return Promise.resolve({ error: null });
        case 'connection.testCancel': return Promise.resolve({ cancelled: false });
        case 'connection.test':
          return Promise.resolve({ ok: true, cancelled: false, firstTokenMs: 1, totalMs: 2, text: 'ok', thinking: false,
            error: null });
        case 'session.state': return Promise.resolve(stateResult());
        case 'session.list':
          status.queries.push(command);
          return Promise.resolve(listResult());
        case 'trust.check':
          status.queries.push(command);
          return Promise.resolve(trustResult(command.cwd));
        case 'session.read':
          status.queries.push(command);
          return readResult(command.sessionFile);
        default: return replayCommand(command);
      }
    },
    onEvent(listener) { listeners.event.add(listener); return () => listeners.event.delete(listener); },
    onKernelExit(listener) { listeners.exit.add(listener); return () => listeners.exit.delete(listener); },
    onKernelReady(listener) {
      listeners.ready.add(listener);
      if (!status.exited) queueMicrotask(listener);
      return () => listeners.ready.delete(listener);
    },
    restartKernel() {
      status.exited = false;
      setTimeout(() => { for (const listener of listeners.ready) listener(); }, 50);
      return Promise.resolve();
    },
    pickFolder() { return Promise.resolve(nextFolder()); },
    ...stubs,
    ...issuesStubs(status, fixture, steps),
  };
  const control = {
    status,
    f8,
    feedback,
    /** synthetic：下一条界面命令直接以这段原文失败（测发送时就失败）；null 表示照常回放 */
    failNext: null,
    /** @brief 模拟后台进程退出。 */
    exit(code = 1) {
      status.exited = true;
      status.exitCode = code;
      for (const listener of listeners.exit) listener(code);
    },
  };
  return { bridge, control };
}
