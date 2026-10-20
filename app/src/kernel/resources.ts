// 工具页（docs/v0/screens/tools.md）：跟随的会话注册的工具、全部技能、插件（pi 包）、MCP 服务，以及技能和包的启停。
// 列表照 pi config：DefaultPackageManager.resolve() 列出全部资源（含停用的）；只读地列出时缺的 npm / git 包跳过、不下载，
// 也不写任何文件。项目信任时显示"加上项目设置"的结果，并与"只按用户设置"的结果对比：项目设置改了启停的用户级资源只读。
// 启停照搬 pi config 的写法（resourceToggles.ts）；包的添加、移除用 pi 的 addSourceToSettings / removeSourceFromSettings。

import { readFile, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type {
  AgentSession, DefaultPackageManager, PackageSource, ResolvedPaths, ResolvedResource, SettingsManager, ToolInfo,
} from '@earendil-works/pi-coding-agent';
import {
  RESOURCE_KINDS, type PackageEntry, type ResourceEntry, type ResourceKind, type SaveResult, type ToolEntry,
  type ToolsInfo,
} from '../shared/protocol';
import { readMcpServers } from './mcpConfig';
import { loadPi, type Pi } from './pi';
import { togglePackageResource, toggleTopLevelResource, type ToggleContext } from './resourceToggles';
import { sessionContext, type SessionContext } from './sessions';

/** 技能正文最多交给界面的字符数 */
const BODY_LIMIT = 20_000;
/** pi 的 MCP 扩展注册的工具的来源路径 */
const MCP_PATH = 'builtin:mcp';
/** 不能在这里启停的原因（界面文字）：项目设置停用了这个用户级资源 */
const DISABLED_BY_PROJECT = '本项目的 .pi/settings.json 把它停用了，只能在项目里改';
/** 项目设置启用了这个用户级资源 */
const ENABLED_BY_PROJECT = '本项目的 .pi/settings.json 把它启用了，只能在项目里改';
/** 本项目设置里的包和它的资源 */
const PROJECT_SETTINGS = '本项目的设置，只能在项目里改';

/** @brief 一次 resolve：用的设置、包管理器和结果。 */
interface View {
  /** 这次用的设置；启停写它 */
  settings: SettingsManager;
  /** 这次用的包管理器 */
  manager: DefaultPackageManager;
  /** 全部资源，含停用的 */
  paths: ResolvedPaths;
}

/** @brief 工具页看到的资源。 */
interface Views {
  /** pi 模块 */
  pi: Pi;
  /** 跟随的会话；没有会话时为 null */
  context: SessionContext | null;
  /** 跟随的会话的工作目录；没有会话时为 agentDir */
  cwd: string;
  /** pi 的配置目录 */
  agentDir: string;
  /** 只按用户设置（projectTrusted: false） */
  user: View;
  /** 显示的：跟随的会话信任了项目时加上项目设置，否则就是 user */
  shown: View;
}

/** @brief 用一份设置 resolve 一次。 */
async function resolveView(pi: Pi, cwd: string, agentDir: string, projectTrusted: boolean): Promise<View> {
  const settings = pi.SettingsManager.create(cwd, agentDir, { projectTrusted });
  const manager = new pi.DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  return { settings, manager, paths: await manager.resolve(async () => 'skip') };
}

/** @brief 跟随的会话（没有时只看用户级）的两种视图。 */
async function resolveViews(sessionId: string | undefined): Promise<Views> {
  const pi = await loadPi();
  const agentDir = pi.getAgentDir();
  const context = sessionId ? sessionContext(sessionId) : null;
  const cwd = context?.cwd ?? agentDir;
  const user = await resolveView(pi, cwd, agentDir, false);
  const shown = context?.trusted ? await resolveView(pi, cwd, agentDir, true) : user;
  return { pi, context, cwd, agentDir, user, shown };
}

/** @brief 显示的是项目视图时，同一个资源在"只按用户设置"视图里的样子；显示的就是用户视图、或它不在用户视图里时为 undefined。 */
function userBase(views: Views, kind: ResourceKind, resource: ResolvedResource): ResolvedResource | undefined {
  if (views.shown === views.user) return undefined;
  return views.user.paths[kind].find((item) => item.path === resource.path);
}

/**
 * @brief 不能在这里启停的原因；能启停时为 null。项目设置改了用户级资源的启停，或接管了它（pi config -l 把它的路径
 *        写进项目设置，项目视图里它成了项目设置的条目，启停可能相同），都只能在项目里改；本项目设置里的包也一样。
 */
function readOnlyReason(views: Views, kind: ResourceKind, resource: ResolvedResource): string | null {
  const base = userBase(views, kind, resource);
  const byProject = resource.enabled ? ENABLED_BY_PROJECT : DISABLED_BY_PROJECT;
  if (base && base.enabled !== resource.enabled) return byProject;
  if (resource.metadata.scope === 'project' && resource.metadata.origin === 'package') return PROJECT_SETTINGS;
  if (base && base.metadata.scope !== resource.metadata.scope) return byProject;
  return null;
}

/** @brief 资源的显示名，同 pi config：技能取所在文件夹名，不在 extensions 文件夹里的扩展带上文件夹名。 */
function displayName(kind: ResourceKind, path: string): string {
  const fileName = basename(path);
  const parentFolder = basename(dirname(path));
  if (kind === 'extensions' && parentFolder !== 'extensions') return `${parentFolder}/${fileName}`;
  if (kind === 'skills' && fileName === 'SKILL.md') return parentFolder;
  return fileName;
}

/** @brief 技能的名字和用途（pi loadSkills 只读这一个）和正文（去掉 frontmatter，截到 BODY_LIMIT）。 */
async function skillDetails(views: Views, path: string): Promise<Pick<ResourceEntry, 'name' | 'description' | 'body'>> {
  const [skill] = views.pi.loadSkills({ cwd: views.cwd, agentDir: views.agentDir, skillPaths: [path],
    includeDefaults: false }).skills;
  let body: string | null = null;
  try {
    body = views.pi.stripFrontmatter(await readFile(path, 'utf8')).slice(0, BODY_LIMIT);
  } catch (error) {
    console.error(`[kernel] cannot read the skill body of ${path}: ${(error as Error).message}`);
  }
  return { name: skill?.name ?? displayName('skills', path), description: skill?.description ?? null, body };
}

/** @brief 工具页的一个资源；来源（用户级 / 本项目 / 包）按用户视图里的它，被项目设置改了的用户级资源仍标用户级。 */
async function describeResource(views: Views, kind: ResourceKind, resource: ResolvedResource): Promise<ResourceEntry> {
  const { metadata } = userBase(views, kind, resource) ?? resource;
  const details = kind === 'skills' ? await skillDetails(views, resource.path)
    : { name: displayName(kind, resource.path), description: null, body: null };
  return { kind, path: resource.path, ...details, enabled: resource.enabled,
    scope: metadata.scope === 'project' ? 'project' : 'user', origin: metadata.origin,
    packageSource: metadata.origin === 'package' ? metadata.source : null,
    readOnly: readOnlyReason(views, kind, resource) };
}

/** @brief 显示的视图里的全部资源，按"种类:路径"。 */
async function describeAll(views: Views): Promise<Map<string, ResourceEntry>> {
  const entries = new Map<string, ResourceEntry>();
  for (const kind of RESOURCE_KINDS) {
    for (const resource of views.shown.paths[kind]) {
      entries.set(`${kind}:${resource.path}`, await describeResource(views, kind, resource));
    }
  }
  return entries;
}

/** @brief 设置里写的包的来源。 */
function sourceOf(pkg: PackageSource): string {
  return typeof pkg === 'string' ? pkg : pkg.source;
}

/**
 * @brief 一个包的卡。包里有哪些资源，看写着这个包的那份设置的视图（用户级的包看"只按用户设置"，免得被项目的同一个包
 *        顶掉），每个资源的启停和只读取显示的视图。
 */
function packageEntry(views: Views, entries: Map<string, ResourceEntry>, source: string,
  scope: 'user' | 'project'): PackageEntry {
  const view = scope === 'user' ? views.user : views.shown;
  const resources = RESOURCE_KINDS.flatMap((kind) => view.paths[kind]
    .filter(({ metadata }) => metadata.origin === 'package' && metadata.scope === scope && metadata.source === source)
    .flatMap((resource) => entries.get(`${kind}:${resource.path}`) ?? []));
  return { source, scope, root: view.manager.getInstalledPath(source, scope) ?? null, resources,
    readOnly: scope === 'project' ? PROJECT_SETTINGS : null };
}

/** @brief 用户级设置的包，加上信任后项目设置的包。 */
function packageEntries(views: Views, entries: Map<string, ResourceEntry>): PackageEntry[] {
  const user = views.user.settings.getGlobalSettings().packages ?? [];
  const project = views.shown.settings.getProjectSettings().packages ?? [];
  return [...user.map((pkg) => packageEntry(views, entries, sourceOf(pkg), 'user')),
    ...project.map((pkg) => packageEntry(views, entries, sourceOf(pkg), 'project'))];
}

/** @brief pi 设置报告的错误原文；只要某一份设置（global / project）的时候按 scope 筛选。 */
function settingsErrors(settings: SettingsManager, scope?: 'global' | 'project'): string[] {
  return settings.drainErrors().filter((item) => scope === undefined || item.scope === scope)
    .map((item) => `${item.path ?? item.scope}: ${item.error.message}`);
}

/** @brief 新会话会报告的技能问题：pi 的资源加载器只对启用的技能调用 loadSkills，这里也一样。 */
function skillDiagnostics(views: Views): string[] {
  const skillPaths = views.shown.paths.skills.filter((item) => item.enabled).map((item) => item.path);
  const { diagnostics } = views.pi.loadSkills({ cwd: views.cwd, agentDir: views.agentDir, skillPaths,
    includeDefaults: false });
  return diagnostics.map((item) => {
    if (item.collision) return `${item.collision.loserPath}: ${item.message} (${item.collision.winnerPath} is used)`;
    return item.path ? `${item.path}: ${item.message}` : item.message;
  });
}

/** @brief 工具的来源：MCP 服务、内置、包、内联扩展（Mori 的批准扩展）或扩展文件。 */
function toolSource(tool: ToolInfo): Pick<ToolEntry, 'source' | 'sourceLabel'> {
  const { path, origin, source } = tool.sourceInfo;
  const server = tool.namespace?.aliases?.[0] ?? tool.namespace?.name ?? '';
  if (path === MCP_PATH) return { source: 'mcp', sourceLabel: server };
  if (path.startsWith('builtin:')) return { source: 'builtin', sourceLabel: '' };
  if (origin === 'package') return { source: 'package', sourceLabel: source };
  if (path.startsWith('<inline:')) return { source: 'other', sourceLabel: path };
  return { source: 'extension', sourceLabel: path };
}

/** @brief 会话注册的工具（不含 hidden），按 pi 的顺序。 */
function toolEntries(session: AgentSession): ToolEntry[] {
  const active = new Set(session.getActiveToolNames());
  return session.getAllTools().filter((tool) => tool.exposure !== 'hidden').map((tool) => ({
    name: tool.name, description: tool.description, active: active.has(tool.name), exposure: tool.exposure,
    ...toolSource(tool) }));
}

/** @brief MCP 服务，每个带上会话里它注册的工具名（按 namespace 的别名归到服务下，不含 hidden）。 */
async function mcpInfo(context: SessionContext): Promise<NonNullable<ToolsInfo['mcp']>> {
  const { servers, errors } = await readMcpServers(context.cwd, context.trusted);
  const tools = context.session.getAllTools()
    .filter((tool) => tool.sourceInfo.path === MCP_PATH && tool.exposure !== 'hidden');
  return { errors, servers: servers.map((server) => ({ ...server,
    tools: tools.filter((tool) => tool.namespace?.aliases?.includes(server.name)).map((tool) => tool.name) })) };
}

/** @brief 工具页的全部内容；没有会话时只有用户级的技能和包。 */
export async function readTools(sessionId?: string): Promise<ToolsInfo> {
  const views = await resolveViews(sessionId);
  const { context } = views;
  const entries = await describeAll(views);
  const errors = [...settingsErrors(views.user.settings), ...settingsErrors(views.shown.settings)];
  return {
    cwd: context?.cwd ?? null,
    // SessionContext 只带是否信任；工具页只分信任与否（不信任和没有回答一样显示）
    projectTrust: context?.projectTrust ?? null,
    tools: context ? toolEntries(context.session) : null,
    skills: views.shown.paths.skills.flatMap((item) => entries.get(`skills:${item.path}`) ?? []),
    packages: packageEntries(views, entries),
    mcp: context ? await mcpInfo(context) : null,
    diagnostics: [...new Set([...errors, ...skillDiagnostics(views)])],
  };
}

/**
 * @brief 启停一个资源，写法照 pi config：顶层资源写它所在的那份设置（用户级或本项目），包里的写 packages 的过滤数组。
 *        先重新 resolve 找到这一项；只读的拒绝。返回 pi 设置报告的错误（写的那份设置的）。
 */
export async function toggleResource(sessionId: string | undefined, kind: ResourceKind, path: string,
  enabled: boolean): Promise<SaveResult> {
  const views = await resolveViews(sessionId);
  const resource = views.shown.paths[kind].find((item) => item.path === path);
  if (!resource) throw new Error(`Resource not found: ${path}`);
  if (readOnlyReason(views, kind, resource)) throw new Error(`${path} can only be changed in the project settings`);
  const item = { path, metadata: resource.metadata, resourceType: kind };
  const context: ToggleContext = { settings: views.shown.settings, cwd: views.cwd, agentDir: views.agentDir,
    configDirName: views.pi.CONFIG_DIR_NAME };
  if (resource.metadata.origin === 'top-level') toggleTopLevelResource(item, enabled, context);
  else if (!togglePackageResource(item, enabled, context)) {
    throw new Error(`Package ${resource.metadata.source} is not in the settings`);
  }
  await context.settings.flush();
  const scope = resource.metadata.scope === 'project' ? 'project' : 'global';
  return { error: settingsErrors(context.settings, scope).join('; ') || null };
}

/**
 * @brief 用户级设置和包管理器。包管理器的工作目录取 agentDir：pi 按工作目录解析传入的本地来源、按 agentDir 解析
 *        用户级设置里写的来源，这样设置里写的相对来源原样传进去也能对上。
 */
async function userPackages(): Promise<{ settings: SettingsManager; manager: DefaultPackageManager }> {
  const pi = await loadPi();
  const agentDir = pi.getAgentDir();
  const settings = pi.SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
  return { settings, manager: new pi.DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager: settings }) };
}

/** @brief 等用户级设置写完，返回 pi 报告的错误。 */
async function savedUser(settings: SettingsManager): Promise<SaveResult> {
  await settings.flush();
  return { error: settingsErrors(settings, 'global').join('; ') || null };
}

/**
 * @brief 添加本地包（pi install <本地文件夹> 的写法）：路径相对 agentDir 写进用户级设置的 packages，不复制文件。
 *        已经有同一个文件夹时拒绝（写法不同时 pi 会把原来那一项改成规范的写法）。
 */
export async function addPackage(path: string): Promise<{ source: string; error: string | null }> {
  const stats = await stat(path).catch(() => null);
  if (!stats?.isDirectory()) throw new Error(`Folder not found: ${path}`);
  const { settings, manager } = await userPackages();
  const count = settings.getGlobalSettings().packages?.length ?? 0;
  const changed = manager.addSourceToSettings(path);
  const packages = settings.getGlobalSettings().packages ?? [];
  if (!changed || packages.length === count) {
    await settings.flush();
    throw new Error('This package is already added');
  }
  const { error } = await savedUser(settings);
  return { source: sourceOf(packages[packages.length - 1]), error };
}

/**
 * @brief 停用整个包（四类都写成 []，pi docs/packages.md 的写法）或启用整个包（去掉过滤，写回字符串）。只改用户级的包。
 * @param source 设置里写的来源
 */
export async function setPackageEnabled(source: string, enabled: boolean): Promise<SaveResult> {
  const { settings } = await userPackages();
  const packages = [...(settings.getGlobalSettings().packages ?? [])];
  const index = packages.findIndex((pkg) => sourceOf(pkg) === source);
  if (index === -1) throw new Error(`Package ${source} is not in the user settings`);
  packages[index] = enabled ? source : { source, extensions: [], skills: [], prompts: [], themes: [] };
  settings.setPackages(packages);
  return savedUser(settings);
}

/** @brief 从用户级设置里移除一个包（pi removeSourceFromSettings），不删文件。 */
export async function removePackage(source: string): Promise<SaveResult> {
  const { settings, manager } = await userPackages();
  if (!manager.removeSourceFromSettings(source)) throw new Error(`Package ${source} is not in the user settings`);
  return savedUser(settings);
}
