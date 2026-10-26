// Customize › Agents 的命令（docs/specs/customize-agents.md §4、§5）：roles.get 读跟随的会话所在项目的 .mori/agents，
// 逐个文件检查（inspectRoleFiles，与会话打开时的启动校验同一套规则），用模型层算每个 agent 的候选与原因；
// roles.save 先用同一套规则检查要写的全文，合格才写（先写临时文件再改名）；roles.delete 删除文件。
// 后台进程只在这里写 .mori/agents（§3）；路径一律按项目根和文件名拼出，不接受绝对路径或 ..。
// 每个函数分两层：rolesInfoIn / saveRoleIn / deleteRoleIn 只用项目根和给定的依赖（单元测试直接调用），
// getRoles / saveRole / deleteRole 由会话 id 取出项目根、模型范围、模型层与 pi 的设置。

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelPick } from '../shared/models';
import type {
  AgentDraft, AgentView, RoleCandidate, RoleRange, RolesDeleteResult, RolesGetResult, RolesInfo, RolesSaveResult,
} from '../shared/roles';
import { BASE_ROLE, BASE_ROLE_DESCRIPTION, SEATS, type TeamHolders } from '../shared/team';
import { writeFileAtomic } from './agents';
import { getModelLayer } from './modelLayer';
import type { ModelRef, Requirement } from './modelTypes';
import { createSettingsManager, loadPi } from './pi';
import { agentFileName, hasHeaderComments, keptFields, newAgentFile, roleFileText, type RoleHeader } from './roleFiles';
import {
  PI_DEFAULT_TOOLS, PI_TOOL_NAMES, inspectRoleFiles, nameProblems, readRoleFiles, type RoleDeps, type RoleFileReport,
  type RoleFileText,
} from './roles';
import { pickItems, staticExclusion, type StaticSelectorInput } from './selector';
import { sessionContext, sessionPick } from './sessions';

/** @brief 编辑的文件不在了，或路径不是 .mori/agents 下的一个 .md 文件（§5.2）。 */
const GONE = 'This agent file no longer exists.';

/** @brief 基座的能力要求：只有隐含的 tool_calling。 */
const TOOL_CALLING: readonly Requirement[] = [{ kind: 'tool_calling' }];

/** @brief 候选的来源（§4.2，同 TaskBoard 规格 §12.1）：会话的范围、按顺序展开去重、第 1、3 步的查询。 */
export interface RoleCandidateSource {
  /** 会话的模型范围；没有时为 null */
  pick: ModelPick | null;
  /**
   * @brief 在这个项目里把几个范围依次展开、去重（modelLayer.expandPicksIn）。
   * @param picks 范围，按顺序
   */
  expand(picks: readonly ModelPick[]): ModelRef[];
  /** 选择器第 1、3 步的查询（modelLayer.staticBase），不含候选与能力要求 */
  base: Omit<StaticSelectorInput, 'candidates' | 'requires'>;
}

/** @brief 读写一个项目的 agent 要用的全部依赖。 */
export interface RolesSetup {
  /** 项目根 */
  cwd: string;
  /** 模型设置里的名字、pi 的 parseFrontmatter */
  deps: RoleDeps;
  /** 候选的来源 */
  source: RoleCandidateSource;
  /** 表单可选的模型范围 */
  ranges: RoleRange[];
  /** 新会话会用的默认工具 */
  baseTools: readonly string[];
}

/**
 * @brief 一个 agent 会按顺序用的模型与能不能用（§4.2）：models 依次展开、去重，没写时用会话的范围；每个候选按选择器
 *        第 1、3 步（加上这个 agent 的 requires）判断，不通过时是那一步的界面文字。
 * @param source 候选的来源
 * @param models agent 写的范围；null 用会话的范围
 * @param requires 能力要求（含隐含的 tool_calling）
 * @return 会话没有范围、又没写 models 时为空
 */
export function roleCandidates(source: RoleCandidateSource, models: readonly string[] | null,
  requires: readonly Requirement[]): RoleCandidate[] {
  const picks = models ?? (source.pick === null ? [] : [source.pick]);
  if (picks.length === 0) return [];
  const input: StaticSelectorInput = { ...source.base, candidates: [], requires };
  return source.expand(picks).map((ref) => ({ ref, reason: staticExclusion(input, ref)?.detail ?? null }));
}

/** @brief requires 里 tool_calling 以外的项，原文，去重（Model needs 一块）。 */
function needsOf(fields: Record<string, unknown> | null): string[] {
  const items: unknown[] = Array.isArray(fields?.requires) ? fields.requires : [];
  return [...new Set(items.filter((item): item is string => typeof item === 'string' && item !== 'tool_calling'))];
}

/** @brief 一个文件的 agent：合格的给出全部字段与候选；有问题的只有名字、路径与问题。 */
function fileView(setup: RolesSetup, report: RoleFileReport): AgentView {
  const head = { file: report.file, path: join(setup.cwd, ...report.file.split('/')), problems: report.problems,
    headerComments: report.text !== null && hasHeaderComments(report.text) };
  const { role } = report;
  if (!role) {
    const description = typeof report.fields?.description === 'string' ? report.fields.description : '';
    return { ...head, name: report.name, description, body: '', seats: [], tools: null, models: null, needs: [],
      differFromAuthor: false, subscribe: [], candidates: [] };
  }
  return { ...head, name: role.name, description: role.description, body: role.body, seats: role.seats,
    tools: role.tools, models: role.models, needs: needsOf(report.fields), differFromAuthor: role.differFromAuthor,
    subscribe: role.subscribe, candidates: roleCandidates(setup.source, role.models, role.requires) };
}

/** @brief 基座 mori：没有文件，持有没人认领的职责，用会话的范围。 */
function baseView(setup: RolesSetup, holders: TeamHolders): AgentView {
  return { name: BASE_ROLE, file: null, path: null, description: BASE_ROLE_DESCRIPTION, body: '',
    seats: SEATS.filter((seat) => holders[seat] === BASE_ROLE), tools: null, models: null, needs: [],
    differFromAuthor: false, subscribe: [], candidates: roleCandidates(setup.source, null, TOOL_CALLING), problems: [],
    headerComments: false };
}

/**
 * @brief 读到的文件 → RolesInfo（§4.1）：基座在第一个，文件按读的顺序（文件名）；problems 与启动校验的问题行相同。
 * @param setup 项目与依赖
 * @param files readRoleFiles 的结果
 */
export function rolesView(setup: RolesSetup, files: readonly RoleFileText[]): RolesInfo {
  const { reports, holders } = inspectRoleFiles(files, setup.deps);
  return {
    cwd: setup.cwd, dir: join(setup.cwd, '.mori', 'agents'), pick: setup.source.pick, holders,
    problems: reports.flatMap((report) => report.problems.map((problem) => `${report.file}: ${problem}`)),
    agents: [baseView(setup, holders), ...reports.map((report) => fileView(setup, report))],
    ranges: setup.ranges, piTools: [...PI_TOOL_NAMES], baseTools: [...setup.baseTools],
  };
}

/** @brief 错误的原文（异常分支记日志）。 */
function failure(what: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[kernel] ${what} failed: ${message}`);
  return message;
}

/** @brief roles.get（§4.1）：目录读不出时 info 为 null、error 为原文（§4.3）。 */
export async function rolesInfoIn(setup: RolesSetup): Promise<RolesGetResult> {
  try {
    return { info: rolesView(setup, await readRoleFiles(setup.cwd)), error: null };
  } catch (error) {
    return { info: null, error: failure('roles.get', error) };
  }
}

/** @brief 要写的全文或不写的原因。 */
type SavePlan = { file: string; text: string } | { error: string };

/** @brief 表单的字段与保留的字段 → 文件头。说明去掉首尾空白（读回时校验也是这样取的）。 */
function headerOf(draft: AgentDraft, kept: Pick<RoleHeader, 'requires' | 'differ_from' | 'subscribe'>): RoleHeader {
  return { name: draft.name, description: draft.description.trim(), tools: draft.tools, models: draft.models,
    seats: SEATS.filter((seat) => draft.seats.includes(seat)), ...kept };
}

/**
 * @brief 用启动校验的规则检查要写的文件（§5.2）：把它放在其他文件之后一起检查，所以与别的文件冲突时问题都落在它身上；
 *        别的文件自己的问题不算。
 */
function checked(deps: RoleDeps, others: readonly RoleFileText[], file: string, text: string): SavePlan {
  const { reports } = inspectRoleFiles([...others, { file, text }], deps);
  const problems = reports[reports.length - 1].problems;
  return problems.length ? { error: problems.join('\n') } : { file, text };
}

/** @brief 编辑（§5.3）：文件名不变，requires、differ_from、subscribe 原样写回；文件不在了时 GONE。 */
function planEdit(deps: RoleDeps, files: readonly RoleFileText[], file: string, draft: AgentDraft): SavePlan {
  const current = agentFileName(file) === null ? undefined : files.find((entry) => entry.file === file);
  if (!current || !('text' in current)) return { error: GONE };
  let frontmatter: unknown = null;
  try {
    frontmatter = deps.parseFrontmatter(current.text).frontmatter;
  } catch (error) {
    failure(`reading ${file}`, error);
  }
  const text = roleFileText(headerOf(draft, keptFields(frontmatter)), draft.body);
  return checked(deps, files.filter((entry) => entry !== current), file, text);
}

/**
 * @brief 要写什么（§5.1、§5.2）：新建时先看名字，再看 <name>.md 是否已经存在（Windows 上不分大小写），再用启动校验的规则查；
 *        编辑见 planEdit。纯函数。
 * @param deps 模型设置里的名字、pi 的 parseFrontmatter
 * @param files 目录里现在的文件
 * @param file 编辑的文件；null 为新建
 * @param draft 表单的字段
 */
export function planSave(deps: RoleDeps, files: readonly RoleFileText[], file: string | null,
  draft: AgentDraft): SavePlan {
  if (file !== null) return planEdit(deps, files, file, draft);
  const names = nameProblems(draft.name);
  if (names.length > 0) return { error: names.join('\n') };
  const target = newAgentFile(draft.name);
  if (files.some((entry) => entry.file.toLowerCase() === target.toLowerCase())) {
    return { error: `A file named ${target} already exists.` };
  }
  return checked(deps, files, target, roleFileText(headerOf(draft, {}), draft.body));
}

/** @brief roles.save（§5.1）：检查通过才写，写完重新读。 */
export async function saveRoleIn(setup: RolesSetup, file: string | null, draft: AgentDraft): Promise<RolesSaveResult> {
  let plan: SavePlan;
  try {
    plan = planSave(setup.deps, await readRoleFiles(setup.cwd), file, draft);
  } catch (error) {
    return { info: null, file: null, error: failure('roles.save', error) };
  }
  if ('error' in plan) return { info: null, file: null, error: plan.error };
  try {
    await mkdir(join(setup.cwd, '.mori', 'agents'), { recursive: true });
    await writeFileAtomic(join(setup.cwd, ...plan.file.split('/')), plan.text);
  } catch (error) {
    return { info: null, file: null, error: failure(`writing ${plan.file}`, error) };
  }
  const read = await rolesInfoIn(setup);
  return { info: read.info, file: plan.file, error: read.error };
}

/** @brief roles.delete（§5.4）：直接删除（不进回收站）；文件已经不在也算成功。 */
export async function deleteRoleIn(setup: RolesSetup, file: string): Promise<RolesDeleteResult> {
  const name = agentFileName(file);
  if (name === null) return { info: null, error: GONE };
  try {
    await rm(join(setup.cwd, '.mori', 'agents', name), { force: true });
  } catch (error) {
    return { info: null, error: failure(`deleting ${file}`, error) };
  }
  return rolesInfoIn(setup);
}

/**
 * @brief 一个打开着的会话的项目与依赖：项目根、会话的模型范围、模型层（展开与第 1、3 步）、表单可选的范围（同模型菜单），
 *        以及按这个项目重新读的 pi 设置里的默认工具（§4.1：Built-in tools 的开关改了之后这里跟着变）。
 */
async function setupOf(sessionId: string): Promise<RolesSetup> {
  const context = sessionContext(sessionId);
  const [pi, layer] = await Promise.all([loadPi(), getModelLayer()]);
  const project = await layer.projectContext(context.cwd);
  const settings = await createSettingsManager(context.cwd, pi.getAgentDir(), { projectTrusted: context.trusted });
  const config = layer.getConfig();
  return {
    cwd: context.cwd,
    deps: { pickExists: (name) => layer.expandPickIn(project, name) !== null,
      parseFrontmatter: (content) => pi.parseFrontmatter(content) },
    source: { pick: sessionPick(sessionId), expand: (picks) => layer.expandPicksIn(project, picks).refs,
      base: layer.staticBase(project) },
    ranges: config ? pickItems(config) : [],
    baseTools: settings.getDefaultTools() ?? PI_DEFAULT_TOOLS,
  };
}

/** @brief roles.get { sessionId }。 */
export async function getRoles(sessionId: string): Promise<RolesGetResult> {
  return rolesInfoIn(await setupOf(sessionId));
}

/** @brief roles.save { sessionId, file, agent }。 */
export async function saveRole(sessionId: string, file: string | null, agent: AgentDraft): Promise<RolesSaveResult> {
  return saveRoleIn(await setupOf(sessionId), file, agent);
}

/** @brief roles.delete { sessionId, file }。 */
export async function deleteRole(sessionId: string, file: string): Promise<RolesDeleteResult> {
  return deleteRoleIn(await setupOf(sessionId), file);
}
