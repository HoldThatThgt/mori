// MCP 服务的配置（docs/v0/screens/tools.md "MCP"）：读 pi 的两处 mcp.json，写只写用户级的 <agentDir>/mcp.json。
// pi 读配置的函数没有导出，这里照 pi 的规则（extensions/mcp/config.js、docs/mcp.md）读：用户级 <agentDir>/mcp.json，
// 项目信任后再读 <项目>/.pi/mcp.json；项目里有 command / url / type 的条目替换同名的用户级服务，只有 enabled、
// exposure、toolExposure 的条目是对用户级服务的覆盖。mcp.json 的位置取 pi 的 getAgentDir()，与 pi 的 MCP 扩展相同。
// pi 不加载的条目（照 pi 的检查）也列出，带上 pi 的原因；保存时同样检查，pi 不接受的不写。
// 写入只改 mcpServers 里那一项，文件里其他内容和别的服务原样、按原来的顺序保留；读不出的文件不写。
// 另给工具页（resources.ts）和上下文分项（sessions.ts）一个共用的判断：哪些工具是 MCP 服务注册的。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ToolInfo } from '@earendil-works/pi-coding-agent';
import type { McpServerEntry, SaveResult, ToolsInfo } from '../shared/protocol';
import { forgetStaleServers, sharedServerStates } from './mcpShare';
import { loadPi } from './pi';

/** @brief mcp.json 里的一个 JSON 对象。 */
type JsonObject = Record<string, unknown>;

/** pi 的 MCP 扩展注册的工具的来源路径（ToolInfo.sourceInfo.path） */
const MCP_TOOL_PATH = 'builtin:mcp';

/** @brief 这个工具是 MCP 服务的（pi 的 MCP 扩展注册的）。 */
export function isMcpTool(tool: Pick<ToolInfo, 'sourceInfo'>): boolean {
  return tool.sourceInfo.path === MCP_TOOL_PATH;
}

/** 项目覆盖能改的字段（pi OVERRIDE_KEYS） */
const OVERRIDE_KEYS = ['enabled', 'exposure', 'toolExposure'];
/** 服务名只能有字母、数字、_、-（pi SERVER_NAME） */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
/** 本项目的服务不能在这里改的原因（界面文字） */
const PROJECT_READ_ONLY = 'Set in this project’s .pi/mcp.json. To change it, edit that file.';
/** pi 认的调用方式（pi MCP_EXPOSURES；旧名字 codemode-deferred 当作 codemode） */
const MCP_EXPOSURES = ['codemode', 'deferred', 'direct', 'hidden'];
/** pi 当作本机的主机名（pi LOOPBACK_HOSTS） */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** @brief 工具页的 MCP 服务列表（ToolsInfo.mcp）。 */
type McpList = NonNullable<ToolsInfo['mcp']>;

/** @brief 一处 mcp.json。 */
interface Source {
  /** 文件路径 */
  path: string;
  /** 用户级或项目的 */
  scope: 'user' | 'project';
}

/** @brief 读到的服务和读不出的文件。 */
interface ReadState {
  /** pi 会加载的服务，按名字，保持 pi 的顺序（项目的同名条目留在用户级条目的位置上） */
  servers: Map<string, McpServerEntry>;
  /** pi 不加载的条目（problem 是原因），按读到的顺序，列在 pi 会加载的服务后面 */
  rejected: McpServerEntry[];
  /** 读不出的 mcp.json 的原文（不能解析，或不是 { mcpServers: {...} }） */
  errors: string[];
}

/** @brief 是不是普通对象。 */
function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @brief 项目条目只改 enabled / exposure / toolExposure，是对用户级服务的覆盖（pi isOverride）。 */
function isOverride(value: JsonObject): boolean {
  return value.command === undefined && value.url === undefined && value.type === undefined;
}

/** @brief 两个服务名是否算同一个：`-` 和 `_` 算相同（pi mcpNamespace）。 */
function sameName(left: string, right: string): boolean {
  return left.replace(/-/g, '_') === right.replace(/-/g, '_');
}

// ---- 以下照搬 pi 1.3.0 dist/core/mcp-servers.js 的 validateMcpServerConfig（141–203）和它用到的 validateOAuth、
// isLoopbackRedirectUri、isStringRecord、isExposure，检查的顺序和错误原文与 pi 相同。pi 没有导出它（包只导出 "." 和
// "./rpc-entry"），pi 升级时对照复查（docs/v0/defaults.md）。

/** @brief 值都是字符串的对象（pi isStringRecord）。 */
function isStringRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

/** @brief pi 认的调用方式（含旧名字 codemode-deferred）。 */
function isExposure(value: unknown): boolean {
  return typeof value === 'string' && MCP_EXPOSURES.includes(value === 'codemode-deferred' ? 'codemode' : value);
}

/** @brief pi 的本机回调地址：本机主机名上的 http，没有查询串和片段（pi isLoopbackRedirectUri）。 */
function isLoopbackRedirectUri(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname) && url.search === '' && url.hash === '';
}

/** @brief oauth 的 callbackPort、callbackUrl（pi validateOAuth 的一段）；没有问题时为 null。 */
function oauthCallbackProblem(value: JsonObject): string | null {
  const port = value.callbackPort;
  if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) {
    return 'oauth.callbackPort must be a port number';
  }
  if (value.callbackUrl === undefined) return null;
  if (typeof value.callbackUrl !== 'string' || !isLoopbackRedirectUri(value.callbackUrl)) {
    return 'oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment';
  }
  const urlPort = new URL(value.callbackUrl).port;
  if (urlPort && port !== undefined && Number(urlPort) !== port) {
    return 'oauth.callbackUrl and oauth.callbackPort name different ports';
  }
  return null;
}

/** @brief oauth 的 clientRegistration（pi validateOAuth 的一段，callbackUrl 已经检查过）；没有问题时为 null。 */
function oauthRegistrationProblem(value: JsonObject): string | null {
  if (value.clientRegistration === undefined || value.clientRegistration === 'dcr') return null;
  if (value.clientRegistration !== 'cimd') return 'oauth.clientRegistration must be "dcr" or "cimd"';
  if (value.clientId !== undefined || value.clientName !== undefined) {
    return 'oauth.clientRegistration "cimd" cannot be combined with oauth.clientId or oauth.clientName';
  }
  const callback = typeof value.callbackUrl === 'string' ? new URL(value.callbackUrl) : undefined;
  if (callback && (callback.hostname === '[::1]' || callback.pathname !== '/callback')) {
    return 'oauth.clientRegistration "cimd" requires oauth.callbackUrl on localhost or 127.0.0.1 '
      + 'with path /callback';
  }
  return null;
}

/** @brief oauth 的 authServerMetadataUrl（pi validateOAuth 的最后一段）；没有问题时为 null。 */
function metadataUrlProblem(value: unknown): string | null {
  if (value === undefined) return null;
  const url = typeof value === 'string' && URL.canParse(value) ? new URL(value) : undefined;
  if (url && (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname)))) {
    return null;
  }
  return 'oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]';
}

/** @brief HTTP 服务的 oauth（pi validateOAuth）；没写或没有问题时为 null。 */
function oauthProblem(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return 'oauth must be an object';
  if (value.clientId !== undefined && typeof value.clientId !== 'string') return 'oauth.clientId must be a string';
  if (value.clientSecret !== undefined && typeof value.clientSecret !== 'string') {
    return 'oauth.clientSecret must be a string';
  }
  const callback = oauthCallbackProblem(value);
  if (callback) return callback;
  if (value.scope !== undefined && typeof value.scope !== 'string') return 'oauth.scope must be a string';
  const { clientName } = value;
  if (clientName !== undefined && (typeof clientName !== 'string' || !clientName.trim())) {
    return 'oauth.clientName must be a non-empty string';
  }
  return oauthRegistrationProblem(value) ?? metadataUrlProblem(value.authServerMetadataUrl);
}

/** @brief 共有字段 exposure、toolExposure、enabled、description、timeout；没有问题时为 null。 */
function commonProblem(name: string, value: JsonObject): string | null {
  const exposures = MCP_EXPOSURES.map((item) => `"${item}"`).join(', ');
  if (value.exposure !== undefined && !isExposure(value.exposure)) {
    return `server "${name}": exposure must be one of ${exposures}`;
  }
  const { toolExposure, timeout } = value;
  if (toolExposure !== undefined) {
    if (!isRecord(toolExposure)) return `server "${name}": toolExposure must map tool names to exposures`;
    const wrong = Object.entries(toolExposure).find(([, item]) => !isExposure(item));
    if (wrong) return `server "${name}": toolExposure "${wrong[0]}" must be one of ${exposures}`;
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    return `server "${name}": enabled must be a boolean`;
  }
  if (value.description !== undefined && typeof value.description !== 'string') {
    return `server "${name}": description must be a string`;
  }
  if (timeout !== undefined && (typeof timeout !== 'number' || !(timeout > 0))) {
    return `server "${name}": timeout must be a positive number of seconds`;
  }
  return null;
}

/** @brief HTTP 服务：url、headers、oauth、auth；没有问题时为 null。 */
function urlProblem(name: string, value: JsonObject, url: string): string | null {
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
    return `server "${name}": url must be an http or https URL`;
  }
  if (value.headers !== undefined && !isStringRecord(value.headers)) {
    return `server "${name}": headers must map names to strings`;
  }
  const oauth = oauthProblem(value.oauth);
  if (oauth) return `server "${name}": ${oauth}`;
  if (value.auth === undefined) return null;
  if (!isRecord(value.auth) || typeof value.auth.provider !== 'string' || !value.auth.provider) {
    return `server "${name}": auth.provider must be a provider name`;
  }
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && !LOOPBACK_HOSTS.includes(parsed.hostname)) {
    return `server "${name}": auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]`;
  }
  return null;
}

/** @brief stdio 服务：args、env、cwd；没有问题时为 null。 */
function commandProblem(name: string, value: JsonObject): string | null {
  const { args } = value;
  if (args !== undefined && !(Array.isArray(args) && args.every((arg) => typeof arg === 'string'))) {
    return `server "${name}": args must be an array of strings`;
  }
  if (value.env !== undefined && !isStringRecord(value.env)) return `server "${name}": env must map names to strings`;
  if (value.cwd !== undefined && typeof value.cwd !== 'string') return `server "${name}": cwd must be a string`;
  return null;
}

/**
 * @brief pi 不接受这个条目的原因（pi validateMcpServerConfig）；pi 接受时为 null。
 * @param value mcpServers 里这个名字的值（原样）
 */
function entryProblem(name: string, value: unknown): string | null {
  if (!SERVER_NAME.test(name)) return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
  if (!isRecord(value)) return `server "${name}" must be an object`;
  const common = commonProblem(name, value);
  if (common) return common;
  const { type } = value;
  if (type === 'sse') return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;
  if (typeof value.url === 'string' && (type === undefined || type === 'http' || type === 'streamable-http')) {
    return urlProblem(name, value, value.url);
  }
  if (typeof value.command === 'string' && (type === undefined || type === 'stdio')) return commandProblem(name, value);
  return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}

// ---- 照搬结束

/**
 * @brief 读一个 mcp.json（同步，同 pi）：不存在时为 null；不能解析或不是 { mcpServers: {...} } 时报错。
 */
function readConfigFile(path: string): JsonObject | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${(error as Error).message}`);
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    throw new Error(`${path}: expected an object with an "mcpServers" object`);
  }
  return parsed;
}

/**
 * @brief 工具页的一行。
 * @param merged 显示用的条目（被项目覆盖时是合并后的）
 * @param raw 条目原样（以 JSON 编辑用）
 */
function describeServer(name: string, scope: 'user' | 'project', merged: JsonObject, raw: JsonObject): McpServerEntry {
  const exposure = typeof merged.exposure === 'string' ? merged.exposure : 'codemode';
  return {
    name,
    scope,
    enabled: merged.enabled !== false,
    // pi 把旧名字 codemode-deferred 当作 codemode
    exposure: exposure === 'codemode-deferred' ? 'codemode' : exposure,
    command: typeof merged.command === 'string' ? merged.command : null,
    args: Array.isArray(merged.args) ? merged.args.map(String) : [],
    url: typeof merged.url === 'string' ? merged.url : null,
    entry: raw,
    overrides: [],
    tools: null,
    readOnly: scope === 'project' ? PROJECT_READ_ONLY : null,
    problem: null,
    shared: null,
  };
}

/** @brief 记下 pi 不加载的一个条目和原因（pi 在会话开始的 MCP 通知里以 "config: <路径>: <原因>" 报告它）。 */
function reject(source: Source, name: string, value: unknown, problem: string, state: ReadState): void {
  console.error(`[kernel] ${source.path}: ${problem}; pi does not load it`);
  const entry = isRecord(value) ? value : {};
  state.rejected.push({ ...describeServer(name, source.scope, entry, entry), problem });
}

/**
 * @brief 项目里对同名服务的覆盖：合并后显示，列出改了的字段；条目原样仍是被覆盖的那一项。服务仍是用户级、readOnly
 *        为 null：界面按 overrides 让开关和按钮不可用，说明"Overridden by this project: <字段>"（状态表"本项目的"一行）。
 *        pi 不认的覆盖（没有被覆盖的服务、写了别的字段、合并后 pi 不接受）照 pi 的原文记为不加载，用户级服务不变。
 */
function addOverride(source: Source, name: string, value: JsonObject, state: ReadState): void {
  const base = state.servers.get(name);
  if (!base) {
    reject(source, name, value, `server "${name}" needs "command" or "url", or a global server to override`, state);
    return;
  }
  const problem = Object.keys(value).some((key) => !OVERRIDE_KEYS.includes(key))
    ? `server "${name}": an override can only set ${OVERRIDE_KEYS.join(', ')}`
    : entryProblem(name, { ...base.entry, ...value });
  if (problem !== null) {
    reject(source, name, value, problem, state);
    return;
  }
  const merged = describeServer(name, base.scope, { ...base.entry, ...value }, base.entry);
  state.servers.set(name, { ...merged, overrides: Object.keys(value) });
}

/** @brief 定义一个服务的条目，照 pi readConfigFile 的顺序检查：条目本身、与先前的服务重名、项目里的 auth。 */
function addServer(source: Source, name: string, value: unknown, state: ReadState): void {
  const clash = [...state.servers.keys()].find((other) => other !== name && sameName(other, name));
  let problem = entryProblem(name, value);
  if (problem === null && clash !== undefined) problem = `server "${name}" conflicts with "${clash}"`;
  if (problem === null && source.scope === 'project' && isRecord(value) && 'url' in value && value.auth) {
    problem = `server "${name}": auth is only allowed in the global mcp.json`;
  }
  if (problem !== null) {
    reject(source, name, value, problem, state);
    return;
  }
  // pi 接受的条目一定是对象（entryProblem 先检查了）
  const entry = value as JsonObject;
  state.servers.set(name, describeServer(name, source.scope, entry, entry));
}

/** @brief 读一处 mcp.json 加进列表；读不出时记下原文、这一处不列出。 */
function addFile(source: Source, state: ReadState): void {
  let file: JsonObject | null;
  try {
    file = readConfigFile(source.path);
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[kernel] cannot read MCP config: ${message}`);
    state.errors.push(message);
    return;
  }
  for (const [name, value] of Object.entries((file?.mcpServers ?? {}) as JsonObject)) {
    if (source.scope === 'project' && isRecord(value) && isOverride(value)) addOverride(source, name, value, state);
    else addServer(source, name, value, state);
  }
}

/**
 * @brief 两处 mcp.json 的服务（工具名由调用方从会话里补上）：pi 会加载的在前，pi 不加载的（带原因）在后。
 *        pi 会加载的服务带上共享服务表里它的进程状态（用户级的在用户目录里运行，本项目的在这个项目文件夹里）。
 * @param cwd 跟随的会话的工作目录；为 null 或不信任时不读项目的 .pi/mcp.json
 */
export async function readMcpServers(cwd: string | null, trusted: boolean): Promise<McpList> {
  const pi = await loadPi();
  const state: ReadState = { servers: new Map(), rejected: [], errors: [] };
  addFile({ path: join(pi.getAgentDir(), 'mcp.json'), scope: 'user' }, state);
  if (cwd !== null && trusted) addFile({ path: join(cwd, pi.CONFIG_DIR_NAME, 'mcp.json'), scope: 'project' }, state);
  const shared = sharedServerStates(cwd, trusted);
  const servers = [...state.servers.values()].map((server) => ({ ...server,
    shared: shared.get(`${server.scope}:${server.name}`) ?? null }));
  return { servers: [...servers, ...state.rejected], errors: state.errors };
}

/**
 * @brief 改用户级 mcp.json 的 mcpServers 并写回（2 空格缩进加换行）；文件不存在时新建，读不出时报错、不写。
 *        读、改、写临时文件、改名都同步做完（同 pi 的 editMcpServers）：后台进程同时收到的几条命令不会交错，
 *        不会互相盖掉改动，也不会同时写同一个临时文件。写完后关掉配置已经不在、没有会话用的共享服务（mcpShare.ts）。
 * @param edit 收到 mcpServers 和文件路径，返回新的 mcpServers；拒绝时抛错
 */
async function editUserServers(edit: (servers: JsonObject, path: string) => JsonObject): Promise<SaveResult> {
  const pi = await loadPi();
  const path = join(pi.getAgentDir(), 'mcp.json');
  const file = readConfigFile(path) ?? {};
  file.mcpServers = edit((file.mcpServers ?? {}) as JsonObject, path);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
  forgetStaleServers();
  return { error: null };
}

/** @brief 用户级 mcp.json 里写了这个名字（只认文件里写了的，`__proto__` 之类继承来的不算）；没有时报错。 */
function requireName(servers: JsonObject, name: string, path: string): void {
  if (!Object.hasOwn(servers, name)) throw new Error(`MCP server "${name}" is not in ${path}`);
}

/**
 * @brief 用户级 mcp.json 里这个服务的条目（启停、改为直接调用用）；没有，或不是对象时报错。
 *        不是对象的条目 pi 不加载，工具页列出它但开关不可用；改写和移除只要求写了这个名字（requireName）。
 */
function requireServer(servers: JsonObject, name: string, path: string): JsonObject {
  requireName(servers, name, path);
  const server = servers[name];
  if (!isRecord(server)) throw new Error(`server "${name}" must be an object`);
  return server;
}

/** @brief 检查要保存的条目：pi 不接受的拒绝（原文同 pi）；没写 exposure 时补上 direct（v0 只支持直接调用）。 */
function checkedEntry(name: string, entry: JsonObject): JsonObject {
  const server = entry.exposure === undefined ? { ...entry, exposure: 'direct' } : entry;
  const problem = entryProblem(name, server);
  if (problem !== null) throw new Error(problem);
  if (server.exposure !== 'direct') throw new Error('Mori only supports direct calls (exposure: direct).');
  return server;
}

/**
 * @brief 添加（previousName 为 null）或修改一个用户级服务；改名时留在原来的位置。
 *        与别的服务重名（`-` 和 `_` 算相同，同 pi）时拒绝。
 */
export async function saveMcpServer(name: string, previousName: string | null,
  entry: Record<string, unknown>): Promise<SaveResult> {
  const server = checkedEntry(name, entry);
  return editUserServers((servers, path) => {
    if (previousName !== null) requireName(servers, previousName, path);
    const clash = Object.keys(servers).find((other) => other !== previousName && sameName(other, name));
    if (clash !== undefined) throw new Error(`server "${name}" conflicts with "${clash}"`);
    if (previousName === null) return { ...servers, [name]: server };
    return Object.fromEntries(Object.entries(servers).map(([key, value]) =>
      (key === previousName ? [name, server] : [key, value])));
  });
}

/** @brief 启停用户级服务：启用时删掉 enabled（pi 的默认），停用时写 enabled: false。 */
export async function setMcpEnabled(name: string, enabled: boolean): Promise<SaveResult> {
  return editUserServers((servers, path) => {
    const server = requireServer(servers, name, path);
    if (enabled) delete server.enabled;
    else server.enabled = false;
    return servers;
  });
}

/** @brief 把用户级服务改为直接调用（exposure: direct），其他字段不动。 */
export async function setMcpDirect(name: string): Promise<SaveResult> {
  return editUserServers((servers, path) => {
    requireServer(servers, name, path).exposure = 'direct';
    return servers;
  });
}

/** @brief 从用户级 mcp.json 移除一个服务。 */
export async function removeMcpServer(name: string): Promise<SaveResult> {
  return editUserServers((servers, path) => {
    requireName(servers, name, path);
    delete servers[name];
    return servers;
  });
}
