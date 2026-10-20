// MCP 服务的配置（docs/v0/screens/tools.md "MCP"）：读 pi 的两处 mcp.json，写只写用户级的 <agentDir>/mcp.json。
// pi 读配置的函数没有导出，这里照 pi 的规则（extensions/mcp/config.js、docs/mcp.md）读：用户级 <agentDir>/mcp.json，
// 项目信任后再读 <项目>/.pi/mcp.json；项目里有 command / url / type 的条目替换同名的用户级服务，只有 enabled、
// exposure、toolExposure 的条目是对用户级服务的覆盖。mcp.json 的位置取 pi 的 getAgentDir()，与 pi 的 MCP 扩展相同。
// 写入只改 mcpServers 里那一项，文件里其他内容和别的服务原样、按原来的顺序保留；读不出的文件不写。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServerEntry, SaveResult, ToolsInfo } from '../shared/protocol';
import { writeFileAtomic } from './agents';
import { loadPi } from './pi';

/** @brief mcp.json 里的一个 JSON 对象。 */
type JsonObject = Record<string, unknown>;

/** 项目覆盖能改的字段（pi OVERRIDE_KEYS） */
const OVERRIDE_KEYS = ['enabled', 'exposure', 'toolExposure'];
/** 服务名只能有字母、数字、_、-（pi SERVER_NAME） */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
/** 本项目的服务不能在这里改的原因（界面文字） */
const PROJECT_READ_ONLY = '本项目的 .pi/mcp.json，只能在项目里改';

/** @brief 工具页的 MCP 服务列表（ToolsInfo.mcp）。 */
type McpList = NonNullable<ToolsInfo['mcp']>;

/** @brief 读到的服务和读不出的文件。 */
interface ReadState {
  /** 按名字，保持 pi 的顺序（项目的同名条目留在用户级条目的位置上） */
  servers: Map<string, McpServerEntry>;
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

/** @brief 读一个 mcp.json：不存在时为 null；不能解析或不是 { mcpServers: {...} } 时报错。 */
async function readConfigFile(path: string): Promise<JsonObject | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
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
    args: Array.isArray(merged.args) ? merged.args.filter((arg): arg is string => typeof arg === 'string') : [],
    url: typeof merged.url === 'string' ? merged.url : null,
    entry: raw,
    overrides: [],
    tools: null,
    readOnly: scope === 'project' ? PROJECT_READ_ONLY : null,
  };
}

/**
 * @brief 项目里对同名服务的覆盖：合并后显示，列出改了的字段；条目原样仍是被覆盖的那一项。服务仍是用户级、readOnly
 *        为 null：界面按 overrides 让开关和按钮不可用，说明"本项目改了它的 <字段>"（状态表"本项目的"一行）。
 *        pi 不认的覆盖（没有被覆盖的服务、写了别的字段）不列出，pi 在会话开始的 MCP 通知里报告它们。
 */
function addOverride(path: string, name: string, value: JsonObject, state: ReadState): void {
  const base = state.servers.get(name);
  if (!base || Object.keys(value).some((key) => !OVERRIDE_KEYS.includes(key))) {
    console.error(`[kernel] ${path}: the override of MCP server "${name}" is not valid; pi ignores it`);
    return;
  }
  const merged = describeServer(name, base.scope, { ...base.entry, ...value }, base.entry);
  state.servers.set(name, { ...merged, overrides: Object.keys(value) });
}

/** @brief 读一处 mcp.json 加进列表；读不出时记下原文、这一处不列出。 */
async function addFile(path: string, scope: 'user' | 'project', state: ReadState): Promise<void> {
  let file: JsonObject | null;
  try {
    file = await readConfigFile(path);
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[kernel] cannot read MCP config: ${message}`);
    state.errors.push(message);
    return;
  }
  for (const [name, value] of Object.entries((file?.mcpServers ?? {}) as JsonObject)) {
    if (!isRecord(value)) console.error(`[kernel] ${path}: MCP server "${name}" is not an object; pi ignores it`);
    else if (scope === 'project' && isOverride(value)) addOverride(path, name, value, state);
    else state.servers.set(name, describeServer(name, scope, value, value));
  }
}

/**
 * @brief 两处 mcp.json 的服务（工具名由调用方从会话里补上）。
 * @param cwd 跟随的会话的工作目录；为 null 或不信任时不读项目的 .pi/mcp.json
 */
export async function readMcpServers(cwd: string | null, trusted: boolean): Promise<McpList> {
  const pi = await loadPi();
  const state: ReadState = { servers: new Map(), errors: [] };
  await addFile(join(pi.getAgentDir(), 'mcp.json'), 'user', state);
  if (cwd !== null && trusted) await addFile(join(cwd, pi.CONFIG_DIR_NAME, 'mcp.json'), 'project', state);
  return { servers: [...state.servers.values()], errors: state.errors };
}

/**
 * @brief 改用户级 mcp.json 的 mcpServers 并写回（2 空格缩进加换行）；文件不存在时新建，读不出时报错、不写。
 * @param edit 收到 mcpServers 和文件路径，返回新的 mcpServers；拒绝时抛错
 */
async function editUserServers(edit: (servers: JsonObject, path: string) => JsonObject): Promise<SaveResult> {
  const pi = await loadPi();
  const path = join(pi.getAgentDir(), 'mcp.json');
  const file = (await readConfigFile(path)) ?? {};
  file.mcpServers = edit((file.mcpServers ?? {}) as JsonObject, path);
  await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
  return { error: null };
}

/** @brief 用户级 mcp.json 里的这个服务；没有时报错。 */
function requireServer(servers: JsonObject, name: string, path: string): JsonObject {
  const server = servers[name];
  if (!isRecord(server)) throw new Error(`MCP server "${name}" is not in ${path}`);
  return server;
}

/** @brief 检查要保存的条目；没写 exposure 时补上 direct（v0 只支持直接调用）。 */
function checkedEntry(name: string, entry: JsonObject): JsonObject {
  if (!SERVER_NAME.test(name)) throw new Error(`Invalid server name "${name}" (use letters, digits, "_" and "-")`);
  if (typeof entry.command !== 'string' && typeof entry.url !== 'string') {
    throw new Error(`MCP server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`);
  }
  if (entry.exposure === undefined) return { ...entry, exposure: 'direct' };
  if (entry.exposure !== 'direct') throw new Error('v0 only supports direct exposure');
  return entry;
}

/**
 * @brief 添加（previousName 为 null）或修改一个用户级服务；改名时留在原来的位置。
 *        与别的服务重名（`-` 和 `_` 算相同，同 pi）时拒绝。
 */
export async function saveMcpServer(name: string, previousName: string | null,
  entry: Record<string, unknown>): Promise<SaveResult> {
  const server = checkedEntry(name, entry);
  return editUserServers((servers, path) => {
    if (previousName !== null) requireServer(servers, previousName, path);
    const clash = Object.keys(servers).find((other) => other !== previousName && sameName(other, name));
    if (clash !== undefined) throw new Error(`MCP server "${name}" conflicts with "${clash}"`);
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
    requireServer(servers, name, path);
    delete servers[name];
    return servers;
  });
}
