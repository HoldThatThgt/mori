// MCP 共享连接（docs/v0/m6-mcp-shared.md，照 Claude 桌面版每个服务一个进程、所有会话共用）。
// pi 的 MCP 扩展给每个会话的每个服务要一个传输（createMcpExtension 的 createTransport），这里交给它虚拟传输：虚拟传输
// 不起进程，挂到后台进程里的共享服务上。同一个共享键（名字、起进程用的配置、运行目录）只有一个真连接：pi-mcp 的 McpClient 加
// pi 自己的 createDefaultTransport；各会话的请求经这个 McpClient 换成它自己的编号转发，回复、进度按原来的编号送回。
// 用户级服务在用户目录里运行、整个 Mori 一份，启用的 stdio 服务在后台进程启动时就起、一直开到退出 Mori；项目
// .pi/mcp.json 里的服务按项目文件夹共用、在项目文件夹里运行；扩展用 pi.registerMcpServer() 注册的服务不共用。
// 用户级服务没有空闲关闭：只有配置已经不在（或停用）的，在没有会话用它之后关掉。项目的服务在这个项目最后一个用它的
// 会话关闭（归档、删除）之后关掉（docs/v0/defaults.md）。退出前全部关掉。
// pi 的 createDefaultTransport 和 loadMcpConfig 没有导出（包只导出 "." 和 "./rpc-entry"），按 pi 1.3.0 包里的文件路径
// 载入；找不到时报错，不退回别的做法。pi 升级时对照复查。

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  LoadedMcpConfig, McpServerEntry as PiMcpEntry, McpTransportFactory,
} from '@earendil-works/pi-coding-agent';
import type {
  AuthProvider, InitializeResult, JsonRpcId, JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, McpClient, McpError,
  McpRequestOptions, McpTransport, McpTransportCloseListener, McpTransportErrorListener, McpTransportMessageListener,
  McpTransportSendOptions, ProgressNotification, Root,
} from '@earendil-works/pi-mcp';
import type { SharedServerState } from '../shared/protocol';
import { loadPi, type Pi } from './pi';

/** pi 的包名（核对按路径找到的包） */
const PI_PACKAGE = '@earendil-works/pi-coding-agent';
/** 对照过内部文件的 pi 版本（package.json 锁的同一个版本）；pi 升级时复查 runtime.js、config.js 再改 */
const PI_REVIEWED_VERSION = '1.3.0';
/** pi 内置 MCP 扩展的路径（`extensions` 设置里写 `-builtin:mcp` 停用） */
const MCP_EXTENSION_PATH = 'builtin:mcp';
/** pi 1.3.0 里 createDefaultTransport 所在的文件（相对 pi 的包目录） */
const PI_RUNTIME_FILE = 'dist/extensions/mcp/runtime.js';
/** pi 1.3.0 里 loadMcpConfig 所在的文件 */
const PI_CONFIG_FILE = 'dist/extensions/mcp/config.js';
/** 没写 timeout 时的请求超时（秒），同 pi 的 DEFAULT_TIMEOUT_SECONDS */
const DEFAULT_TIMEOUT_SECONDS = 60;
/**
 * 共享键里不算的配置项（pi 的 OVERRIDE_KEYS）：只决定 pi 在会话里用不用、怎样给出这个服务的工具，不影响起进程、
 * 连 HTTP。项目的覆盖、工具页的启停和"Switch to direct calls"只改这些，同一个用户级服务仍只有一个进程。
 */
const SESSION_ONLY_KEYS = ['enabled', 'exposure', 'toolExposure'];
/** 失败原文里 stderr 末尾的长度，同 pi 的 STDERR_TAIL_CHARS */
const STDERR_TAIL_CHARS = 2_000;
/** 服务主动发的、给所有挂着的会话的通知 */
const BROADCAST_NOTIFICATIONS = [
  'notifications/tools/list_changed', 'notifications/resources/list_changed', 'notifications/prompts/list_changed',
  'notifications/resources/updated',
];
/** 服务的日志通知：只给最早挂上的会话（pi 把它写进 mcp.log，每个会话都给就会重复写） */
const LOG_NOTIFICATION = 'notifications/message';
/** 会话关了它的连接时，交给服务的取消原因 */
const SESSION_CLOSED = 'The session closed its MCP connection';
/** 共享连接关了时，这个会话挂着的请求的中止原因 */
const SHARED_CLOSED = 'The shared MCP connection closed';
/**
 * 新进程最多等同一个键的旧进程退出多久（ms）：pi 关 stdio 服务时先关 stdin、等 500 ms，再结束进程树、最多等 2 s；
 * 过了这些时间还没关完的，是服务起的子进程还占着输出管道，不是服务自己，不再等
 */
const CLOSE_WAIT_MS = 3_000;

/** @brief pi 的 loadMcpConfig 的参数。 */
interface LoadConfigOptions {
  /** pi 的配置目录 */
  agentDir: string;
  /** 读项目 .pi/mcp.json 时的项目文件夹 */
  cwd: string;
  /** 是否读项目的 .pi/mcp.json */
  projectTrusted: boolean;
}

/** @brief 共享连接用到的模块：pi-mcp，和按文件路径载入的 pi 内部函数。 */
interface Modules {
  /** pi-mcp：McpClient、错误类型、StdioTransport、JSON-RPC 判断 */
  mcp: typeof import('@earendil-works/pi-mcp');
  /** pi 的版本（McpClient 的 clientInfo，同 pi） */
  version: string;
  /** pi 的配置目录（mcp.json 所在） */
  getAgentDir: () => string;
  /** pi 内部的 createDefaultTransport（extensions/mcp/runtime.js）：pi 原来起进程、连 HTTP 的方式 */
  createDefaultTransport: McpTransportFactory;
  /** pi 内部的 loadMcpConfig（extensions/mcp/config.js）：pi 读 mcp.json 的方式 */
  loadMcpConfig: (options: LoadConfigOptions) => LoadedMcpConfig;
}

/** @brief 一个共享服务：一个共享键，和它现在的真连接。 */
interface SharedServer {
  /** 共享键：[名字, 配置（不含 SESSION_ONLY_KEYS）, 运行目录] 的规范 JSON */
  key: string;
  /** pi 的服务条目（第一次用到这个键的那一份；名字和起进程、连 HTTP 用的配置与键相同） */
  entry: PiMcpEntry;
  /** 运行目录：项目级为会话的项目文件夹，否则为用户目录 */
  runCwd: string;
  /** 来自项目的 .pi/mcp.json */
  project: boolean;
  /** 进程状态（工具页）；关掉的服务从共享服务表里去掉，不另记状态 */
  state: SharedServerState['state'];
  /** 失败的原文；没有时为 null */
  error: string | null;
  /** 现在的真连接；没有起、失败了或断了时为 undefined，下一次挂上时重新连（pi 下一次调用时重连） */
  link: Link | undefined;
  /** 用户级的配置已经不在或停用了：没有会话用它之后关掉（项目的服务没有会话用就关，不看这一项） */
  stale: boolean;
}

/** @brief 一个真连接：一个 McpClient 和 pi 建的传输（一个服务进程或一个 HTTP 会话）。 */
interface Link {
  /** 所属的共享服务 */
  server: SharedServer;
  /** 和服务说话的 McpClient（自己的请求编号；roots、ping 由它自己回答） */
  client: McpClient;
  /** pi 的 createDefaultTransport 建的传输；还没建时为 undefined */
  transport: McpTransport | undefined;
  /** 握手完成时得到握手结果；失败时以原文 reject */
  ready: Promise<InitializeResult>;
  /** 握手缓存：服务对 initialize 的回答；握手完成前为 undefined */
  init: InitializeResult | undefined;
  /** 挂着的虚拟传输，按挂上的先后 */
  subscribers: Set<SharedTransport>;
  /** Mori 自己在关它（退出、配置不在了），不算断开 */
  closing: boolean;
  /** HTTP 会话过期了（服务重启、闲置太久）：之后的请求换到这个服务现在的连接上重发 */
  expired: boolean;
  /** Mori 开始关它的时刻（ms）；还没关时为 0 */
  closedAt: number;
}

/** 共享服务表，按共享键 */
const servers = new Map<string, SharedServer>();
/** 还开着的真连接（含 HTTP 会话过期后另起了新连接、旧的还有会话在用的） */
const links = new Set<Link>();
/** 正在关的真连接（进程还没退出）：关完时完成的 Promise → 连接；同一个键的新连接、退出 Mori 时等它们关完 */
const closing = new Map<Promise<void>, Link>();
let modules: Modules | undefined;
let loading: Promise<Modules> | undefined;
/** 正在退出：不再起新的连接 */
let shuttingDown = false;

/** @brief 是不是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @brief 错误的原文（同 pi 的 errorMessage）。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** @brief 按文件 URL 动态载入（构建时不打包、不改写这个地址）。 */
function importUrl(url: string): Promise<Record<string, unknown>> {
  return import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>;
}

/**
 * @brief pi 的包目录：pi 按它自己的 dist 所在位置找到的（getPackageDir），开发构建和 app.asar 里都一样；
 *        核对包名和版本是对照过内部文件的版本（载入 pi 之前去掉了 PI_PACKAGE_DIR，pi.ts，所以这就是 Mori 自带的 pi）。
 */
export function piPackageDir(pi: Pi): string {
  const dir = pi.getPackageDir();
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
  if (manifest.name !== PI_PACKAGE || manifest.version !== PI_REVIEWED_VERSION || pi.VERSION !== PI_REVIEWED_VERSION) {
    throw new Error(`${dir} is not ${PI_PACKAGE} ${PI_REVIEWED_VERSION} (running pi ${pi.VERSION})`);
  }
  return dir;
}

/** @brief 载入 pi-mcp 和 pi 内部的 createDefaultTransport、loadMcpConfig。 */
async function loadModules(): Promise<Modules> {
  const pi = await loadPi();
  const dir = piPackageDir(pi);
  const runtime = await importUrl(pathToFileURL(join(dir, PI_RUNTIME_FILE)).href);
  const config = await importUrl(pathToFileURL(join(dir, PI_CONFIG_FILE)).href);
  if (typeof runtime.createDefaultTransport !== 'function' || typeof config.loadMcpConfig !== 'function') {
    throw new Error(`createDefaultTransport or loadMcpConfig is missing in ${dir} (pi ${pi.VERSION})`);
  }
  const mcp = await import('@earendil-works/pi-mcp');
  return { mcp, version: pi.VERSION, getAgentDir: pi.getAgentDir,
    createDefaultTransport: runtime.createDefaultTransport as McpTransportFactory,
    loadMcpConfig: config.loadMcpConfig as Modules['loadMcpConfig'] };
}

/**
 * @brief 载入共享连接要用的模块（只载入一次）；会话注册 MCP 扩展之前、启动共享服务之前调用。
 *        载入失败时记录错误并抛出（之后每次都抛同一个错误，不退回 pi 原来的传输）。
 */
export async function loadMcpShare(): Promise<void> {
  loading ??= loadModules().then((loaded) => {
    modules = loaded;
    return loaded;
  }, (error: unknown) => {
    const message = `Cannot load pi's createDefaultTransport and loadMcpConfig: ${errorMessage(error)}`;
    console.error(`[kernel] ${message}`);
    throw new Error(message);
  });
  await loading;
}

/** @brief 已载入的模块；还没载入时报错。 */
function loaded(): Modules {
  if (!modules) throw new Error('Shared MCP servers are not loaded; call loadMcpShare() first');
  return modules;
}

/** @brief 对象的键按字母排序（数组保持顺序），用来写规范 JSON。 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

/** @brief 共享键：[名字, 配置（不含 SESSION_ONLY_KEYS）, 运行目录] 的规范 JSON。 */
function shareKey(entry: PiMcpEntry, runCwd: string): string {
  const connection = Object.fromEntries(Object.entries(entry.config)
    .filter(([key]) => !SESSION_ONLY_KEYS.includes(key)));
  return JSON.stringify(canonical([entry.name, connection, runCwd]));
}

/**
 * @brief 找到或新建这个键的共享服务（新建时还没有连接）。
 * @param current 新建用户级的共享服务时问：它的键是不是用户级 mcp.json 里现在启用的服务。不是（还开着的旧会话按改之前
 *        的配置重连）就记为配置已经不在，最后一个会话不用它之后关掉
 */
function serverFor(entry: PiMcpEntry, runCwd: string, current: (key: string) => boolean): SharedServer {
  const key = shareKey(entry, runCwd);
  let server = servers.get(key);
  if (!server) {
    const project = entry.scope === 'project';
    server = { key, entry, runCwd, project, state: 'starting', error: null, link: undefined,
      stale: !project && !current(key) };
    servers.set(key, server);
  }
  return server;
}

/** @brief 挂着的会话的项目文件夹（roots），按地址去重。 */
function rootsOf(subscribers: Set<SharedTransport>): Root[] {
  const roots = new Map<string, Root>();
  for (const { root } of subscribers) if (!roots.has(root.uri)) roots.set(root.uri, root);
  return [...roots.values()];
}

/** @brief 服务主动发的通知：列表变化广播给所有挂着的会话，日志只给最早挂上的会话；连接的错误记日志。 */
function routeNotifications(link: Link): void {
  const { client, subscribers, server } = link;
  for (const method of BROADCAST_NOTIFICATIONS) {
    client.onNotification(method, (params) => {
      for (const subscriber of subscribers) subscriber.notify(method, params);
    });
  }
  client.onNotification(LOG_NOTIFICATION, (params) => {
    subscribers.values().next().value?.notify(LOG_NOTIFICATION, params);
  });
  client.onError((error) => console.error(`[kernel] MCP server "${server.entry.name}": ${error.message}`));
}

/**
 * @brief 共享 HTTP 连接用的登录凭据提供者：每次转给还挂着的会话里最早挂上、有提供者的那个（pi 给每个会话的每个服务
 *        建一个，凭据存在同一个文件里，登录的询问也落在那个会话上），不留住已经关了的会话。HTTP 连接在最后一个会话
 *        取消挂上时关掉（release），所以连着时总有会话挂着。
 * @param retries pi 的提供者有没有 onUnauthorized（OAuth 有，`auth.provider` 没有）；没有时 401 不重试，同 pi
 */
function sharedAuth(subscribers: Set<SharedTransport>, retries: boolean): AuthProvider {
  const provider = (): AuthProvider | undefined => [...subscribers].find((item) => item.authProvider)?.authProvider;
  const token = async (): Promise<string | undefined> => provider()?.token();
  if (!retries) return { token };
  return {
    token,
    onUnauthorized: async (context) => {
      await provider()?.onUnauthorized?.(context);
    },
  };
}

/**
 * @brief 起一个真连接（pi 的方式起进程或连 HTTP、握手），在后台进行；结果记在共享服务的状态里。
 * @param authProvider 第一个挂上的会话的登录凭据提供者；有时（HTTP）连接改用转给挂着的会话的 sharedAuth
 */
function openLink(server: SharedServer, authProvider: AuthProvider | undefined): Link {
  const { mcp, version } = loaded();
  const subscribers = new Set<SharedTransport>();
  const client = new mcp.McpClient({ name: 'pi', version,
    requestTimeoutMs: (server.entry.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
    roots: () => rootsOf(subscribers) });
  // ready 紧接着由 connect 填上（connect 要用到这个连接本身）
  const link = { server, client, transport: undefined, init: undefined, subscribers, closing: false,
    expired: false, closedAt: 0 } as Link;
  routeNotifications(link);
  links.add(link);
  server.link = link;
  setState(server, 'starting', null);
  link.ready = connect(link, authProvider && sharedAuth(subscribers, authProvider.onUnauthorized !== undefined));
  // 没有会话在等时（启动时起的服务）失败也已经记在状态里
  link.ready.catch(() => undefined);
  return link;
}

/** @brief 记下共享服务的进程状态和失败原文。 */
function setState(server: SharedServer, state: SharedServerState['state'], error: string | null): void {
  server.state = state;
  server.error = error;
}

/**
 * @brief 等一个正在关的连接关完，最多等到它开始关之后 CLOSE_WAIT_MS（过了这个时刻还没关完的，是服务起的子进程占着
 *        管道，不是服务自己）；不会失败。
 */
async function waitForClose(done: Promise<void>, link: Link): Promise<void> {
  const wait = link.closedAt + CLOSE_WAIT_MS - Date.now();
  if (wait <= 0) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, wait);
  });
  await Promise.race([done, timeout]);
  clearTimeout(timer);
}

/** @brief 等同一个键的旧 stdio 进程都退出，每个最多等到它开始关之后 CLOSE_WAIT_MS；不会失败。 */
async function waitForCloses(key: string): Promise<void> {
  const entries = [...closing].filter(([, link]) => link.server.key === key && 'command' in link.server.entry.config);
  await Promise.all(entries.map(([done, link]) => waitForClose(done, link)));
}

/**
 * @brief 连接并握手；成功后记下握手缓存、开始监听连接断开。stdio 服务先等同一个键的旧进程退出（配置改回去、重连时
 *        不会新旧两个进程同时占着端口、文件锁；最多等 CLOSE_WAIT_MS），等的时候被关掉了就不再起。
 */
async function connect(link: Link, authProvider: AuthProvider | undefined): Promise<InitializeResult> {
  const { server, client } = link;
  try {
    await waitForCloses(server.key);
    if (link.closing) throw new Error('closed before connecting');
    link.transport = loaded().createDefaultTransport(server.entry, server.runCwd, authProvider);
    const init = await client.connect(link.transport);
    if (client.connectionState !== 'connected') throw new Error('connection closed during setup');
    link.init = init;
    client.onClose(() => linkClosed(link));
    if (server.link === link) server.state = 'running';
    const where = 'command' in server.entry.config ? ` in ${server.runCwd}` : '';
    console.log(`[kernel] shared MCP server "${server.entry.name}" is running${where}`);
    return init;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw linkFailed(link, error);
  }
}

/** @brief stdio 服务的 stderr 末尾（同 pi）；不是 stdio 或没有输出时为空串。 */
function stderrTail(link: Link): string {
  const { StdioTransport } = loaded().mcp;
  return link.transport instanceof StdioTransport ? link.transport.stderr.trim().slice(-STDERR_TAIL_CHARS) : '';
}

/**
 * @brief 连接失败：原文照 pi 的 connectFailed（错误原文，stdio 时换行接上 stderr 末尾），记为 failed，丢掉这个连接
 *        （下一次挂上时重新连）。返回给等着的会话的错误：有 stderr 时是带原文的新错误，否则是原来的错误
 *        （pi 按错误的类型认出要登录的 HTTP 服务）。
 */
function linkFailed(link: Link, error: unknown): unknown {
  const { server } = link;
  const tail = stderrTail(link);
  const text = tail ? `${errorMessage(error)}\n${tail}` : errorMessage(error);
  links.delete(link);
  link.subscribers.clear();
  if (server.link === link) {
    server.link = undefined;
    setState(server, 'failed', text);
  }
  if (!link.closing) console.error(`[kernel] shared MCP server "${server.entry.name}" failed to connect: ${text}`);
  return tail ? new Error(text) : error;
}

/**
 * @brief 共享连接断了（服务进程退出、崩溃）或被关掉：意外断开时记为 failed，原文照 pi 的 handleClientClose；
 *        告诉所有挂着的虚拟传输"关了"，pi 在每个会话里标成断开，下一次调用时重连（再挂上时重新起进程）。
 */
function linkClosed(link: Link): void {
  const { server } = link;
  links.delete(link);
  if (server.link === link && !link.closing) {
    const tail = stderrTail(link);
    const error = tail ? `Connection closed\n${tail}` : 'Connection closed';
    server.link = undefined;
    setState(server, 'failed', error);
    console.error(`[kernel] shared MCP server "${server.entry.name}" closed: ${error}`);
  }
  dropSubscribers(link);
}

/** @brief 让挂着的虚拟传输都关掉（中止挂着的请求，告诉 pi 连接关了）。 */
function dropSubscribers(link: Link): void {
  const subscribers = [...link.subscribers];
  link.subscribers.clear();
  for (const subscriber of subscribers) subscriber.drop(link);
}

/** @brief 关掉真连接的 McpClient（传输关闭 → pi 先关 stdin、等进程退出，过了宽限期再结束进程树）；不会失败。 */
async function closeClient(link: Link): Promise<void> {
  try {
    await link.client.close();
  } catch (error) {
    console.error(`[kernel] closing shared MCP server "${link.server.entry.name}" failed: ${errorMessage(error)}`);
  }
}

/**
 * @brief Mori 自己关掉一个真连接；返回的 Promise 在进程退出（HTTP 会话关掉）、还在进行的握手也结束之后完成（同 pi
 *        关连接时等 opening），不会失败。关的过程中记在 closing 里；已经在关的返回同一个 Promise。
 *        共享服务的当前连接只在它已经从共享服务表里去掉之后关（forget、退出），所以不另记状态。
 */
function closeLink(link: Link): Promise<void> {
  if (link.closing) return [...closing].find(([, item]) => item === link)?.[0] ?? Promise.resolve();
  const { server } = link;
  link.closing = true;
  link.closedAt = Date.now();
  links.delete(link);
  if (server.link === link) server.link = undefined;
  dropSubscribers(link);
  const done: Promise<void> = Promise.all([closeClient(link), link.ready.catch(() => undefined)])
    .then(() => undefined).finally(() => closing.delete(done));
  closing.set(done, link);
  return done;
}

/** @brief 从共享服务表里去掉一个共享服务，关掉它的连接；返回的 Promise 在连接关完之后完成。 */
function forget(server: SharedServer): Promise<void> {
  servers.delete(server.key);
  return server.link ? closeLink(server.link) : Promise.resolve();
}

/** @brief 挂上共享服务：没有真连接时起一个；退出中拒绝。 */
function acquire(transport: SharedTransport, entry: PiMcpEntry, runCwd: string,
  authProvider: AuthProvider | undefined): Link {
  if (shuttingDown) throw new Error('Mori is shutting down');
  const server = serverFor(entry, runCwd, isCurrentUserKey);
  const link = server.link ?? openLink(server, authProvider);
  link.subscribers.add(transport);
  return link;
}

/**
 * @brief 取消挂上。订阅数归零时用户级 stdio 服务的进程照旧开着（照 Claude 桌面版，开到退出），除非配置已经不在了；
 *        项目的服务关掉（这个项目已经没有会话用它）；HTTP 服务关掉（没有进程要留着，下一次用时再连，也不会在没有会话、
 *        没有登录凭据时还连着）；另起了新连接之后的旧连接（HTTP 会话过期）关掉。
 *        返回的 Promise 在要关的连接关完（进程退出）之后完成，同 pi 自己的传输关闭：pi 的重连、session_shutdown 等它，
 *        新进程不会和还没退出的旧进程同时占着端口、文件锁等。
 */
function release(link: Link, transport: SharedTransport): Promise<void> {
  if (!link.subscribers.delete(transport) || link.subscribers.size > 0) return Promise.resolve();
  const { server } = link;
  if (server.link !== link) return closeLink(link);
  if (server.project || server.stale || 'url' in server.entry.config) return forget(server);
  return Promise.resolve();
}

/**
 * @brief 去掉 pi 加的 _meta.progressToken（共享的 McpClient 自己加它的），返回去掉后的参数和原来的 token；
 *        没有 token 时参数原样。
 */
function withoutProgressToken(params: unknown): { params: Record<string, unknown> | undefined;
  token: JsonRpcId | undefined; } {
  if (!isRecord(params)) return { params: undefined, token: undefined };
  const { _meta: meta, ...rest } = params;
  if (!isRecord(meta) || meta.progressToken === undefined) return { params, token: undefined };
  const { progressToken, ...others } = meta;
  const stripped = Object.keys(others).length > 0 ? { ...rest, _meta: others } : rest;
  return { params: stripped, token: progressToken as JsonRpcId };
}

/**
 * @brief 这次失败是不是因为 HTTP 会话过期（记在连接上）：只认服务说的过期，那时服务一定没有执行这次请求（同 pi 只在
 *        这时重试）；连接断了、超时等不算，服务可能已经执行过。
 */
function expiredOn(link: Link, error: unknown): boolean {
  if (!(error instanceof loaded().mcp.McpSessionExpiredError)) return false;
  link.expired = true;
  return true;
}

/** @brief JSON-RPC 错误对象，保留 McpError 的 code、message、data。 */
function rpcError(error: McpError): { code: number; message: string; data?: unknown } {
  return { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) };
}

/**
 * @brief 交给 pi 的虚拟传输（实现 pi-mcp 的 McpTransport）：每个会话每个服务一个，自己不起进程，挂到共享服务上。
 *        消息都异步交给 pi（同 pi-mcp 的 InMemoryTransport），"关了"排在已经交出的消息后面。
 */
class SharedTransport implements McpTransport {
  /** 这个会话的项目文件夹（共享服务回答 roots 用） */
  readonly root: Root;
  /** pi 的服务条目（共享键的名字和配置） */
  private readonly entry: PiMcpEntry;
  /** 共享服务的运行目录 */
  private readonly runCwd: string;
  /** pi 给这个会话的这个服务建的登录凭据提供者（HTTP）；共享连接的 sharedAuth 转给它 */
  readonly authProvider: AuthProvider | undefined;
  /** pi 的 McpClient 收消息的监听 */
  private readonly messageListeners = new Set<McpTransportMessageListener>();
  /** 错误监听（接口要求；传输层的错误由共享的 McpClient 记日志，不交给每个会话） */
  private readonly errorListeners = new Set<McpTransportErrorListener>();
  /** "连接关了"的监听 */
  private readonly closeListeners = new Set<McpTransportCloseListener>();
  /** 转发出去、还没回答的请求（按 pi 的编号）；中止即取消共享 McpClient 上的那个请求 */
  private readonly pending = new Map<JsonRpcId, AbortController>();
  /** 每个连接上转发出去、还没回答的请求数；HTTP 会话过期后，旧连接上的都结束了才从它上面取下 */
  private readonly inFlight = new Map<Link, number>();
  /** close() 时中止：start() 不再等共享服务连好 */
  private readonly stop = new AbortController();
  /** 挂着的真连接；start() 之前为 undefined */
  private link: Link | undefined;
  /** start() 已经调用过 */
  private started = false;
  /** 已经关了（pi 关的，或共享连接断了）：不再收发 */
  private closed = false;
  /** "关了"已经排进待交的消息 */
  private closeQueued = false;
  /** "关了"已经交给 pi：之后的消息不再交 */
  private closeEmitted = false;

  /**
   * @param runCwd 共享服务的运行目录
   * @param cwd 会话的项目文件夹
   */
  constructor(entry: PiMcpEntry, runCwd: string, cwd: string, authProvider: AuthProvider | undefined) {
    this.entry = entry;
    this.runCwd = runCwd;
    this.authProvider = authProvider;
    this.root = { uri: pathToFileURL(cwd).href, name: basename(cwd) };
  }

  /** @brief 挂上共享服务并等它连好；失败时取消挂上，以原文抛错；连好之前 close() 了以"连接关了"抛错。 */
  async start(): Promise<void> {
    const { McpConnectionClosedError } = loaded().mcp;
    if (this.started || this.closed) throw new McpConnectionClosedError();
    this.started = true;
    const link = acquire(this, this.entry, this.runCwd, this.authProvider);
    this.link = link;
    const stopped = new Promise<never>((_, reject) => {
      this.stop.signal.addEventListener('abort', () => reject(new McpConnectionClosedError()), { once: true });
    });
    try {
      await Promise.race([link.ready, stopped]);
    } catch (error) {
      void release(link, this);
      throw error;
    }
  }

  /**
   * @brief pi 发来的消息：请求转发或自己回答，通知只认取消，回复不转发（服务的请求由共享的 McpClient 自己回答，
   *        pi 这边收不到服务的请求）。刚换到新连接（HTTP 会话过期）、它还在连时先等它连好。
   */
  async send(message: JsonRpcMessage, options?: McpTransportSendOptions): Promise<void> {
    const { mcp } = loaded();
    const link = this.link;
    if (this.closed || !link) throw new mcp.McpConnectionClosedError();
    if (options?.signal?.aborted) return;
    if (mcp.isJsonRpcRequest(message)) await this.request(link, link.init ?? (await link.ready), message);
    else if (mcp.isJsonRpcNotification(message)) this.notified(message);
  }

  /** @brief initialize 按握手缓存回答，ping 自己回答，其他请求转发。 */
  private async request(link: Link, init: InitializeResult, message: JsonRpcRequest): Promise<void> {
    if (message.method === 'initialize') this.deliver({ jsonrpc: '2.0', id: message.id, result: { ...init } });
    else if (message.method === 'ping') this.deliver({ jsonrpc: '2.0', id: message.id, result: {} });
    else await this.forward(link, message);
  }

  /**
   * @brief 经共享的 McpClient 转发一个请求（换成它的编号），进度按 pi 原来的 token 送回这个会话。服务回了 JSON-RPC
   *        错误时照原样回给 pi；被取消、连接关了时不回复；其他失败（超时、连接断了、HTTP 错误）让 send() 以原来的
   *        错误失败，pi 的 McpClient 把它当作这次请求的失败，拿到的错误类型与 pi 自己的传输相同。
   *        HTTP 会话过期时换到新连接重发一次（rejoin），pi 看不到过期。
   */
  private async forward(link: Link, message: JsonRpcRequest): Promise<void> {
    const { mcp } = loaded();
    const controller = new AbortController();
    this.pending.set(message.id, controller);
    const { params, token } = withoutProgressToken(message.params);
    const onProgress = token === undefined ? undefined
      : (progress: ProgressNotification) => {
        this.notify('notifications/progress', { ...progress, progressToken: token });
      };
    const sendOn = (target: Link): Promise<unknown> =>
      this.requestOn(target, message.method, params, { signal: controller.signal, onProgress });
    try {
      const result = await sendOn(link).catch(async (error: unknown) => {
        if (controller.signal.aborted || !expiredOn(link, error)) throw error;
        return sendOn(await this.rejoin(link));
      });
      if (!controller.signal.aborted) this.deliver({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof mcp.McpError) {
        this.deliver({ jsonrpc: '2.0', id: message.id, error: rpcError(error) });
        return;
      }
      console.error(`[kernel] MCP server "${this.entry.name}": ${message.method} failed: ${errorMessage(error)}`);
      throw error;
    } finally {
      if (this.pending.get(message.id) === controller) this.pending.delete(message.id);
    }
  }

  /** @brief 在一个连接上发一个请求，记着这个连接上还有几个没回答；结束后看要不要从过期的旧连接上取下。 */
  private async requestOn(link: Link, method: string, params: Record<string, unknown> | undefined,
    options: McpRequestOptions): Promise<unknown> {
    this.inFlight.set(link, (this.inFlight.get(link) ?? 0) + 1);
    try {
      return await link.client.request(method, params, options);
    } finally {
      const left = (this.inFlight.get(link) ?? 1) - 1;
      if (left > 0) this.inFlight.set(link, left);
      else this.inFlight.delete(link);
      this.leaveExpired(link);
    }
  }

  /**
   * @brief 从已经换走的过期连接上取下：这个会话在它上面的请求都结束了才取下（还在执行的调用照常在旧连接上做完，
   *        同 pi 放下旧连接、不关它），它没有会话挂着时关掉。
   */
  private leaveExpired(link: Link): void {
    if (link.expired && link !== this.link && !this.inFlight.has(link)) void release(link, this);
  }

  /**
   * @brief HTTP 会话过期（服务重启、闲置太久）：服务没有执行这次请求，换到这个服务现在的连接上（没有就另起一个，
   *        同 pi 自己遇到过期时另起会话重试）。同一个会话同时发的其他请求再来时已经换过，直接用新连接。
   *        返回连好的新连接；新连接连不上时以原文抛错，之后告诉 pi 连接关了（pi 下一次调用时重连）。
   */
  private async rejoin(expired: Link): Promise<Link> {
    if (expired.server.link === expired) expired.server.link = undefined;
    if (this.link === expired && !this.closed) this.link = acquire(this, this.entry, this.runCwd, this.authProvider);
    this.leaveExpired(expired);
    const link = this.link;
    if (this.closed || !link || link === expired) throw new (loaded().mcp.McpConnectionClosedError)();
    try {
      await link.ready;
    } catch (error) {
      // 失败的原文先交给 pi（这次请求），再告诉 pi 连接关了
      setTimeout(() => this.drop(link), 0);
      throw error;
    }
    return link;
  }

  /** @brief pi 发来的通知：取消就中止那个请求（共享的 McpClient 再告诉服务）；initialized 等不转发。 */
  private notified(message: JsonRpcNotification): void {
    if (message.method !== 'notifications/cancelled' || !isRecord(message.params)) return;
    const { requestId, reason } = message.params;
    const controller = typeof requestId === 'string' || typeof requestId === 'number'
      ? this.pending.get(requestId) : undefined;
    controller?.abort(typeof reason === 'string' ? reason : 'Aborted');
  }

  /** @brief 交给 pi 一条服务的通知（列表变化、日志、进度）。 */
  notify(method: string, params: unknown): void {
    this.deliver({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  /** @brief 异步交给 pi 一条消息；"关了"已经交出之后不再交。 */
  private deliver(message: JsonRpcMessage): void {
    queueMicrotask(() => {
      if (this.closeEmitted) return;
      for (const listener of this.messageListeners) {
        try {
          listener(message);
        } catch (error) {
          console.error(`[kernel] MCP server "${this.entry.name}": a message listener failed: ${errorMessage(error)}`);
        }
      }
    });
  }

  /** @brief 中止这个会话挂着的请求（共享的 McpClient 告诉服务取消）。 */
  private abortPending(reason: string): void {
    const controllers = [...this.pending.values()];
    this.pending.clear();
    for (const controller of controllers) controller.abort(reason);
  }

  /** @brief 告诉 pi 连接关了，只一次，排在已经交出的消息后面。 */
  private emitClose(): void {
    if (this.closeQueued) return;
    this.closeQueued = true;
    queueMicrotask(() => {
      this.closeEmitted = true;
      for (const listener of this.closeListeners) {
        try {
          listener();
        } catch (error) {
          console.error(`[kernel] MCP server "${this.entry.name}": a close listener failed: ${errorMessage(error)}`);
        }
      }
    });
  }

  /**
   * @brief 共享服务的连接断了、被关掉或连不上（已经取消挂上）：是这个会话现在用的连接时，中止挂着的请求，告诉 pi 连接
   *        关了。HTTP 会话过期后已经换走的旧连接关了不算（上面还没回答的请求各自失败）。
   */
  drop(link: Link): void {
    if (link !== this.link) return;
    this.closed = true;
    this.stop.abort();
    this.abortPending(SHARED_CLOSED);
    this.emitClose();
  }

  /**
   * @brief pi 关掉这个会话的连接（session_shutdown、重连）：中止这个会话挂着的请求，取消挂上。用户级服务的进程照旧开着；
   *        取消挂上要关掉连接时（项目的服务、配置已经不在的服务）等进程退出再完成，同 pi 自己的传输。
   */
  async close(): Promise<void> {
    this.stop.abort();
    let released = Promise.resolve();
    if (!this.closed) {
      this.closed = true;
      this.abortPending(SESSION_CLOSED);
      if (this.link) released = release(this.link, this);
    }
    this.emitClose();
    await released;
  }

  /** @brief 监听交给 pi 的消息；返回取消监听的函数。 */
  onMessage(listener: McpTransportMessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  /** @brief 监听传输错误（不会发生：见 errorListeners）；返回取消监听的函数。 */
  onError(listener: McpTransportErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  /** @brief 监听"连接关了"（只发一次）；返回取消监听的函数。 */
  onClose(listener: McpTransportCloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
}

/**
 * @brief 交给 createMcpExtension({ createTransport }) 的传输工厂。用户级、项目级的服务（stdio 和 HTTP）返回虚拟传输；
 *        扩展用 pi.registerMcpServer() 注册的服务照 pi 原来的方式直连（不共用）。先 loadMcpShare()。
 * @param entry pi 的服务条目
 * @param cwd 会话的项目文件夹
 * @param authProvider pi 给这个会话的这个服务建的登录凭据提供者（HTTP）；第一个连上的会话的那一个给共享连接用
 */
export function createSharedTransport(entry: PiMcpEntry, cwd: string,
  authProvider: AuthProvider | undefined): McpTransport {
  const { createDefaultTransport } = loaded();
  if (entry.scope === 'extension') return createDefaultTransport(entry, cwd, authProvider);
  return new SharedTransport(entry, entry.scope === 'project' ? cwd : homedir(), cwd, authProvider);
}

/** @brief 用户级 mcp.json 里的服务（pi 的 loadMcpConfig，不读项目）。 */
function userEntries(): PiMcpEntry[] {
  const { loadMcpConfig, getAgentDir } = loaded();
  const config = loadMcpConfig({ agentDir: getAgentDir(), cwd: homedir(), projectTrusted: false });
  for (const error of config.errors) console.error(`[kernel] MCP config: ${error}`);
  return config.servers;
}

/** @brief 用户级 mcp.json 里现在启用的服务的共享键（在用户目录里运行）。 */
function currentUserKeys(): Set<string> {
  const home = homedir();
  return new Set(userEntries().filter((entry) => entry.config.enabled !== false).map((entry) => shareKey(entry, home)));
}

/**
 * @brief 这个键是不是用户级 mcp.json 里现在启用的服务。pi 的 loadMcpConfig 读不了、写坏了的文件不抛错，只是没有服务
 *        （那时都不是现在的配置）；意外抛错时记录错误，当作是（不因此关掉服务）。
 */
function isCurrentUserKey(key: string): boolean {
  try {
    return currentUserKeys().has(key);
  } catch (error) {
    console.error(`[kernel] cannot read the user MCP config: ${errorMessage(error)}`);
    return true;
  }
}

/**
 * @brief 用户级设置里 pi 的内置 MCP 扩展是否启用：照 pi 的包管理器（`extensions` 里的 `-builtin:mcp` 等写法），
 *        不读项目设置。缺的 npm / git 包跳过、不下载（同工具页）。
 */
async function userMcpEnabled(): Promise<boolean> {
  const pi = await loadPi();
  const agentDir = pi.getAgentDir();
  const settingsManager = pi.SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
  const manager = new pi.DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager,
    builtinExtensions: ['mcp'] });
  const paths = await manager.resolve(async () => 'skip');
  return paths.extensions.some((resource) => resource.path === MCP_EXTENSION_PATH && resource.enabled);
}

/**
 * @brief 后台进程启动时起用户级 mcp.json 里启用的 stdio 服务（还没有会话挂着；HTTP 服务等第一次有会话要用时才连）。
 *        用户级设置停用了 pi 的内置 MCP 扩展时不起（项目设置再打开它时，那个项目的会话来时才连）。
 *        在后台连接，不挡住命令；失败记录日志，状态记为 failed。不会失败。
 */
export async function startSharedServers(): Promise<void> {
  try {
    await loadMcpShare();
    if (!(await userMcpEnabled())) {
      console.log('[kernel] builtin:mcp is disabled in the user settings; MCP servers are not started at launch');
      return;
    }
    const home = homedir();
    for (const entry of userEntries()) {
      if (shuttingDown || entry.config.enabled === false || !('command' in entry.config)) continue;
      const server = serverFor(entry, home, () => true);
      if (!server.link) openLink(server, undefined);
    }
  } catch (error) {
    console.error(`[kernel] cannot start the shared MCP servers: ${errorMessage(error)}`);
  }
}

/**
 * @brief 用户级 mcp.json 写入之后：用户级服务里配置已经不在（删了、改了、停用了）的，没有会话用就关掉，还有会话用就在
 *        最后一个会话不用它之后关掉。项目的服务不看（它们在项目最后一个会话关闭时关掉）。不会失败。
 */
export function forgetStaleServers(): void {
  if (!modules || servers.size === 0) return;
  try {
    const current = currentUserKeys();
    for (const server of [...servers.values()]) {
      if (server.project) continue;
      server.stale = !current.has(server.key);
      if (server.stale && (server.link?.subscribers.size ?? 0) === 0) void forget(server);
    }
  } catch (error) {
    console.error(`[kernel] cannot close the stale shared MCP servers: ${errorMessage(error)}`);
  }
}

/**
 * @brief 退出前关掉全部共享服务（McpClient.close → 传输关闭 → pi 结束进程树），连同之前已经开始关的（会话释放时关掉的
 *        项目服务等），等它们都关完；不会失败。
 */
export async function closeSharedServers(): Promise<void> {
  shuttingDown = true;
  servers.clear();
  for (const link of [...links]) void closeLink(link);
  await Promise.all([...closing.keys()]);
}

/** @brief 工具页一行的状态：这个共享服务的进程状态、在用的会话数、失败原文。 */
function stateOf(server: SharedServer): SharedServerState {
  return { state: server.state, sessions: server.link?.subscribers.size ?? 0, error: server.error };
}

/**
 * @brief 工具页每一行的共享连接状态，按 "<user|project>:<名字>"：按 pi 现在读到的配置（用户级的，信任时加上本项目的）
 *        算出每个服务的共享键，取这个键的共享服务；还在给旧会话用的旧配置的进程不算在这一行里（含手改的配置）。
 *        用户级的服务在用户目录里运行，本项目的在跟随的会话的项目文件夹里。没有共享服务的不在里面（界面不显示）；
 *        读不了配置时记录错误、一个都不给。
 * @param cwd 跟随的会话的项目文件夹；为 null 时只有用户级的
 * @param trusted 这个项目是否信任（读不读项目的 .pi/mcp.json）
 */
export function sharedServerStates(cwd: string | null, trusted: boolean): Map<string, SharedServerState> {
  const states = new Map<string, SharedServerState>();
  if (!modules || servers.size === 0) return states;
  const home = homedir();
  try {
    const { loadMcpConfig, getAgentDir } = modules;
    const config = loadMcpConfig({ agentDir: getAgentDir(), cwd: cwd ?? home,
      projectTrusted: trusted && cwd !== null });
    for (const entry of config.servers) {
      const project = entry.scope === 'project';
      const server = servers.get(shareKey(entry, project && cwd !== null ? cwd : home));
      if (server) states.set(`${project ? 'project' : 'user'}:${entry.name}`, stateOf(server));
    }
  } catch (error) {
    console.error(`[kernel] cannot read the MCP config for the shared server states: ${errorMessage(error)}`);
  }
  return states;
}
