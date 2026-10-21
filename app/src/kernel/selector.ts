// 选择器（docs/specs/model-providers.md §5.1、§5.3、§4.6、§5.8；docs/specs/parallel-agents-taskboard.md §12.1、§12.2、
// §12.9、§12.11）：纯函数。
// 展开选择范围、按第 1–6 步逐项过滤并给出排除原因（第 3 步含角色的能力要求与要避开的模型族）、会话启动的静态校验、
// 顶栏菜单各项的静态校验、候选耗尽时的等待判断。
// 约定：CandidateExclusion.detail 是 §5.3“界面文字”列的完整文字（带 until 部分），界面与说明卡直接显示它。

import { REASON_TEXTS, ZONES, plainReasonText } from '../shared/models';
import type {
  BlockedAction, CandidateExclusion, Capability, ModelBlocked, ModelConfig, ModelReason, PickOption, Zone,
} from '../shared/models';
import type { ModelTimings } from './modelTimings';
import type {
  Availability, AvailabilityReason, ModelCapabilities, ModelRef, ReplyState, Requirement, SelectorInput,
  SelectorResult, TriedReason,
} from './modelTypes';

/** @brief 会自己恢复的原因（§5.8）；其余原因不等待。本段已在 tried 或 earlier 里的候选另外排除（见 canRecover）。 */
export const RECOVERING_REASONS: ReadonlySet<ModelReason> = new Set<ModelReason>([
  'probing', 'rate_limited', 'connection', 'timeout', 'held',
]);

// ---- 展开选择范围（§5.1、§4.3） ----

/**
 * @brief 把一个成员（提供商 id 或 <provider>/<model>）展开成模型列表。
 * @param config 用户级配置
 * @param member 成员
 * @return 模型列表；名字不存在时为 null
 */
function expandMember(config: Pick<ModelConfig, 'providers'>, member: string): ModelRef[] | null {
  const slash = member.indexOf('/');
  const providerId = slash < 0 ? member : member.slice(0, slash);
  const provider = config.providers.find((item) => item.id === providerId);
  if (!provider) return null;
  if (slash < 0) return provider.models.map((model) => `${provider.id}/${model.id}`);
  const modelId = member.slice(slash + 1);
  return provider.models.some((model) => model.id === modelId) ? [member] : null;
}

/**
 * @brief 按项目配置缩小一个分组成员（§4.3）：成员本身列出则整项保留；提供商成员下列出的模型按提供商里的顺序保留。
 * @param config 用户级配置
 * @param member 用户分组的成员
 * @param narrowed 项目配置里这个分组列出的项
 * @return 缩小后的模型列表（可能为空）
 */
function narrowMember(
  config: Pick<ModelConfig, 'providers'>, member: string, narrowed: readonly string[],
): ModelRef[] {
  if (narrowed.includes(member)) return expandMember(config, member) ?? [];
  if (member.includes('/')) return [];
  const all = expandMember(config, member) ?? [];
  return all.filter((ref) => narrowed.includes(ref));
}

/**
 * @brief 把选择范围展开成有序的候选列表（§5.1）；分组按项目配置缩小（§4.3）；同一个模型只保留第一次出现。
 * @param config 用户级配置
 * @param pick 选择范围：分组 id、提供商 id 或 <provider>/<model>
 * @param projectGroups 项目配置的 groups（已校验）；没有时省略
 * @return 候选列表；范围指向的名字不存在时为 null（pick_missing）
 */
export function expandPick(
  config: Pick<ModelConfig, 'providers' | 'groups'>, pick: string, projectGroups?: Readonly<Record<string, string[]>>,
): ModelRef[] | null {
  const group = config.groups.find((item) => item.id === pick);
  if (!group) return expandMember(config, pick);
  const narrowed = projectGroups?.[group.id];
  const refs: ModelRef[] = [];
  for (const member of group.members) {
    const expanded = narrowed ? narrowMember(config, member, narrowed) : (expandMember(config, member) ?? []);
    for (const ref of expanded) if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

/** @brief 几个选择范围依次展开的结果（平行 Agent 规格 §12.1）。 */
export interface ExpandedPicks {
  /** 依次展开、去重后的候选，前面的优先；missing 不为 null 时为空 */
  refs: ModelRef[];
  /** 第一个指向的名字不存在的范围（pick_missing 的细节）；都存在时为 null */
  missing: string | null;
}

/**
 * @brief 把角色的 models（有序的选择范围）依次展开、去重，前面的优先（平行 Agent 规格 §12.1，
 *        统一模型提供商 proposal §4“候选列表”）；只有一个范围时与 expandPick 相同。
 * @param config 用户级配置
 * @param picks 选择范围，按顺序
 * @param projectGroups 项目配置的 groups（已校验）；没有时省略
 */
export function expandPicks(
  config: Pick<ModelConfig, 'providers' | 'groups'>, picks: readonly string[],
  projectGroups?: Readonly<Record<string, string[]>>,
): ExpandedPicks {
  const refs: ModelRef[] = [];
  for (const pick of picks) {
    const expanded = expandPick(config, pick, projectGroups);
    if (expanded === null) return { refs: [], missing: pick };
    for (const ref of expanded) if (!refs.includes(ref)) refs.push(ref);
  }
  return { refs, missing: null };
}

/**
 * @brief 只留在另一组候选里也有的，顺序按 refs（关闭模式下的临时提问：被问角色的候选 ∩ 对话会话的候选，§12.1）。
 * @param refs 被问角色展开后的候选
 * @param within 对话会话展开后的候选
 */
export function intersectCandidates(refs: readonly ModelRef[], within: readonly ModelRef[]): ModelRef[] {
  const allowed = new Set(within);
  return refs.filter((ref) => allowed.has(ref));
}

/**
 * @brief 模型族的键（平行 Agent 规格 §12.9、§15）：配置里模型的 family；为空时用 <provider>/<model> 本身当作族。
 * @param family 配置里的 family
 * @param ref <provider>/<model>
 */
export function familyKey(family: string, ref: ModelRef): string {
  return family === '' ? ref : family;
}

// ---- 原因文字 ----

/**
 * @brief 可用性原因的界面文字（§5.3 第 4 步）。
 * @param reason 原因
 * @param until 恢复时刻；null 时不带 until 部分
 */
export function availabilityText(reason: AvailabilityReason, until: number | null): string {
  if (reason === 'auth') return REASON_TEXTS.auth();
  if (reason === 'quota') return REASON_TEXTS.quota();
  if (reason === 'not_found') return REASON_TEXTS.not_found();
  return REASON_TEXTS[reason](until);
}

/**
 * @brief tried 的排除文字（§5.3 第 5 步）。
 * @param tried 它在本段失败时的原因
 */
export function triedText(tried: TriedReason): string {
  return REASON_TEXTS.tried(plainReasonText(tried.reason, tried.detail));
}

// ---- 第 1–5 步 ----

/** @brief 静态校验要用的输入：选择器输入的第 1–3 步部分（§4.6）。 */
export type StaticSelectorInput = Pick<
  SelectorInput, 'candidates' | 'exists' | 'removedRefs' | 'zoneOf' | 'allowedZones' | 'toolCalling' | 'requires'
  | 'capabilities' | 'avoidFamilies' | 'familyOf'
>;

/**
 * @brief 第 1 步的排除：回复进行中被删除的用 removed 的文字（§4.7）。
 * @param input 选择器输入
 * @param ref 候选
 */
function missingExclusion(input: Pick<SelectorInput, 'removedRefs'>, ref: ModelRef): CandidateExclusion {
  return { ref, reason: 'missing', detail: REASON_TEXTS.missing(input.removedRefs?.has(ref) ?? false) };
}

/**
 * @brief 第 1–3 步（静态）：名字在配置里、区域已确认且允许、tool_calling 已验证，再按角色的能力要求与要避开的模型族。
 * @param input 选择器输入
 * @param ref 候选
 * @return 第一个不满足的条件；都满足为 null
 */
function staticExclusion(input: StaticSelectorInput, ref: ModelRef): CandidateExclusion | null {
  if (!input.exists(ref)) {
    return missingExclusion(input, ref);
  }
  const zone = input.zoneOf(ref);
  if (zone === null) return { ref, reason: 'zone_unconfirmed', detail: REASON_TEXTS.zone_unconfirmed() };
  if (!input.allowedZones.includes(zone)) {
    return { ref, reason: 'zone_blocked', detail: REASON_TEXTS.zone_blocked(zone) };
  }
  const tools = input.toolCalling(ref);
  if (tools !== 'verified') return { ref, reason: tools, detail: REASON_TEXTS[tools]() };
  return roleExclusion(input, ref);
}

// ---- 第 3 步：角色的能力要求与模型族（平行 Agent 规格 §12.2、§12.9） ----

/** @brief 一项能力要求不满足时的原因与细节（没有 ref）。 */
export type RequirementExclusion = Pick<CandidateExclusion, 'reason' | 'detail'>;

/** @brief requires_unmet：细节就是不满足的那一项（§12.2）。 */
function unmet(text: string): RequirementExclusion {
  return { reason: 'requires_unmet', detail: REASON_TEXTS.requires_unmet(text) };
}

/**
 * @brief 必须已验证的能力（protocol_write、structured_output）：未验证且正在探测按 probing（会恢复）；
 *        其余不满足为 requires_unmet（<名字> not verified / <名字> failed verification）。
 * @param name 词表里的名字
 * @param state 档案里的三态
 * @param probing 这个模型正在探测
 */
function verifiedExclusion(name: string, state: Capability, probing: boolean): RequirementExclusion | null {
  if (state === 'verified') return null;
  if (state === 'unverified' && probing) return { reason: 'probing', detail: REASON_TEXTS.probing() };
  return unmet(state === 'failed' ? `${name} failed verification` : `${name} not verified`);
}

/**
 * @brief 一项能力要求的判定（平行 Agent 规格 §12.2，统一模型提供商规格 §10 第 3 行）：protocol_write、structured_output
 *        必须已验证；protocol_write>=B 另要等级 A 或 B；vision 为 unverified（配置声明了图像输入）即满足；context>=N 比较有效窗口。
 *        tool_calling 由选择器先按 toolCalling 判断，这里总是满足。
 * @param requirement 要求
 * @param caps 候选的档案能力
 * @return 不满足时的原因；满足为 null
 */
export function requirementExclusion(requirement: Requirement, caps: ModelCapabilities): RequirementExclusion | null {
  switch (requirement.kind) {
    case 'tool_calling': return null;
    case 'protocol_write': {
      const base = verifiedExclusion('protocol_write', caps.protocolWrite, caps.probing);
      if (base || requirement.min === 'C' || caps.tier !== 'C') return base;
      return unmet('handoff tier C is below B');
    }
    case 'structured_output': return verifiedExclusion('structured_output', caps.structuredOutput, caps.probing);
    case 'vision': return caps.vision === 'failed' ? unmet('vision not declared in your model settings') : null;
    case 'context': return caps.effectiveWindow >= requirement.tokens ? null
      : unmet(`effective window ${caps.effectiveWindow} < ${requirement.tokens}`);
  }
}

/**
 * @brief 第 3 步的角色部分：requires 里 tool_calling 以外的各项按顺序，然后是要避开的模型族（same_family）。
 * @param input 选择器输入
 * @param ref 已通过 tool_calling 的候选
 * @return 第一个不满足的条件；都满足为 null
 */
function roleExclusion(input: StaticSelectorInput, ref: ModelRef): CandidateExclusion | null {
  const extra = (input.requires ?? []).filter((item) => item.kind !== 'tool_calling');
  if (extra.length > 0) {
    if (!input.capabilities) throw new Error('The selector got requirements without the model capabilities');
    const caps = input.capabilities(ref);
    for (const requirement of extra) {
      const exclusion = requirementExclusion(requirement, caps);
      if (exclusion) return { ref, ...exclusion };
    }
  }
  if (!input.avoidFamilies || input.avoidFamilies.size === 0 || !input.familyOf) return null;
  const family = input.familyOf(ref);
  return input.avoidFamilies.has(family) ? { ref, reason: 'same_family', detail: REASON_TEXTS.same_family(family) }
    : null;
}

/**
 * @brief 段内选择时候选是否排在 current 之前（§5.3 第 5 步 earlier）。
 * @param candidates 候选列表
 * @param reply 当前这段
 * @param ref 候选
 */
function isEarlier(candidates: readonly ModelRef[], reply: ReplyState, ref: ModelRef): boolean {
  if (reply.current === null || ref === reply.current) return false;
  if (reply.skipped.has(ref)) return true;
  const currentIndex = candidates.indexOf(reply.current);
  return currentIndex >= 0 && candidates.indexOf(ref) < currentIndex;
}

/**
 * @brief 第 1–5 步。
 * @param input 选择器输入
 * @param ref 候选
 * @return 第一个不满足的条件；都满足为 null
 */
function exclusionThroughStep5(input: SelectorInput, ref: ModelRef): CandidateExclusion | null {
  const first = staticExclusion(input, ref);
  if (first) return first;
  const unavailable = checkCurrent(input, ref);
  if (unavailable) return unavailable;
  const reply = input.reply;
  if (!reply) return null;
  const tried = reply.tried.get(ref);
  if (tried) return { ref, reason: 'tried', detail: triedText(tried) };
  if (isEarlier(input.candidates, reply, ref)) return { ref, reason: 'earlier', detail: REASON_TEXTS.earlier() };
  return null;
}

/**
 * @brief route() 对段内 current 做的检查（§11.1 第 2 步）：只看第 1 步（名字在配置里）与第 4 步（可用）。
 * @param input 选择器输入（只用 exists、removedRefs、availability）
 * @param ref 当前模型
 * @return 第一个不满足的条件；都满足为 null
 */
export function checkCurrent(
  input: Pick<SelectorInput, 'exists' | 'removedRefs' | 'availability'>, ref: ModelRef,
): CandidateExclusion | null {
  if (!input.exists(ref)) {
    return missingExclusion(input, ref);
  }
  const availability = input.availability(ref);
  if (availability.available) return null;
  return { ref, reason: availability.reason, detail: availabilityText(availability.reason, availability.until) };
}

// ---- 选择器 ----

/**
 * @brief 选择器（§5.3）。没有段或段刚开始（current 为 null）：选通过的第一个；段内：current 仍通过第 1–5 步就继续用它，
 *   否则只在排在 current 之后的候选里按顺序选（排在前面的、跳过的按 earlier 排除）。第 6 步只对要换到的候选判断。
 * @param input 选择器输入
 * @return 选中的模型与被排除的候选；选到时 excluded 只含排在它之前被排除的，选不到时含全部候选
 */
export function select(input: SelectorInput): SelectorResult {
  const current = input.reply?.current ?? null;
  if (current !== null && exclusionThroughStep5(input, current) === null) return { model: current, excluded: [] };
  const excluded: CandidateExclusion[] = [];
  for (const ref of input.candidates) {
    let exclusion = exclusionThroughStep5(input, ref);
    if (!exclusion && input.handover) {
      const handover = input.handover(ref);
      if (handover) exclusion = { ref, reason: 'no_handover', detail: handover.detail };
    }
    if (!exclusion) return { model: ref, excluded };
    excluded.push(exclusion);
  }
  return { model: null, excluded };
}

/**
 * @brief 只做第 1–3 步的选择（§4.6 静态校验，不看可用性）。
 * @param input 第 1–3 步的输入
 * @return 第一个通过的候选与排在它之前被排除的；没有通过的时含全部候选
 */
export function selectStatic(input: StaticSelectorInput): SelectorResult {
  const excluded: CandidateExclusion[] = [];
  for (const ref of input.candidates) {
    const exclusion = staticExclusion(input, ref);
    if (!exclusion) return { model: ref, excluded };
    excluded.push(exclusion);
  }
  return { model: null, excluded };
}

// ---- 会话启动校验（§4.6） ----

/** @brief 静态校验的输入（§4.6）。 */
export interface StaticCheckInput extends Omit<StaticSelectorInput, 'candidates'> {
  /** 用户级配置读不出时的“<路径>: <原文>”；读得出为 null（config_invalid） */
  configError: string | null;
  /** 项目配置无效时的原因或校验原文；有效或没有这个文件为 null（project_config） */
  projectError: string | null;
  /** 会话的选择范围；没有时为 null（no_pick） */
  pick: string | null;
  /** 按 §5.1 展开的候选；范围指向的名字不存在时为 null（pick_missing） */
  candidates: readonly ModelRef[] | null;
  /** 项目配置 .mori/models.json 写的 allowedZones；没写或没有这个文件为 null（决定能否提供 allow_zone） */
  projectZones: readonly Zone[] | null;
  /**
   * 卡上换模型的操作（平行 Agent 规格 §12.11）：change_model（你选范围的会话）、turn_off_team（协作模式下的对话会话）、
   * null（角色会话，不提供）；省略时为 change_model
   */
  modelAction?: 'change_model' | 'turn_off_team' | null;
  /**
   * .mori/agents/*.md 的问题（平行 Agent 规格 §4.4，<file>: … 的写法）：不为空时按 agents_invalid 拒绝启动，
   * 优先于其他各项；省略或为空时没有
   */
  agentProblems?: readonly string[];
}

/** @brief 静态校验的结果。 */
export interface StaticCheckResult {
  /** 拒绝启动的说明；可以发送时为 null */
  blocked: ModelBlocked | null;
  /** 静态校验后的第一个候选（没有段时顶栏显示的当前模型）；没有时为 null */
  first: ModelRef | null;
}

/**
 * @brief 不带候选的拒绝说明。
 * @param kind 种类
 * @param detail 细节
 * @param actions 操作
 */
function plainBlocked(kind: ModelBlocked['kind'], detail: string, actions: BlockedAction[]): ModelBlocked {
  return { kind, detail, candidates: [], actions, verifyRefs: [], zone: null, zoneProviders: [], problems: [] };
}

/**
 * @brief 卡上换模型的操作（§4.6 的 Change model；平行 Agent 规格 §12.11：协作模式下的对话会话改为 Turn off team mode，
 *        角色会话不提供），后面跟 Open settings。
 * @param input 静态校验的输入
 */
function modelActions(input: Pick<StaticCheckInput, 'modelAction'>): BlockedAction[] {
  const action = input.modelAction === undefined ? 'change_model' : input.modelAction;
  return action === null ? ['open_settings'] : [action, 'open_settings'];
}

/**
 * @brief 没有候选通过时的拒绝说明：verifying 或 no_candidate 及其操作（§4.6 表）。
 * @param input 静态校验的输入
 * @param excluded 全部候选的排除原因
 */
function candidateBlocked(input: StaticCheckInput, excluded: CandidateExclusion[]): ModelBlocked {
  const probing = excluded.find((item) => item.reason === 'probing');
  if (probing) {
    return { kind: 'verifying', detail: probing.ref, candidates: excluded, actions: [], verifyRefs: [], zone: null,
      zoneProviders: [], problems: [] };
  }
  const verifyRefs = excluded.filter((item) => item.reason === 'unverified').map((item) => item.ref);
  const zone = allowableZone(input, excluded);
  const zoneProviders = [...new Set(excluded.filter((item) => item.reason === 'zone_unconfirmed')
    .map((item) => providerOf(item.ref)))];
  const actions: BlockedAction[] = [];
  if (verifyRefs.length > 0) actions.push('verify');
  if (zone !== null) actions.push('allow_zone');
  if (zoneProviders.length > 0) actions.push('confirm_zone');
  actions.push(...modelActions(input));
  return { kind: 'no_candidate', detail: '', candidates: excluded, actions, verifyRefs, zone, zoneProviders,
    problems: [] };
}

/**
 * @brief Allow <区域> for this project 的区域：第一个 zone_blocked 候选的区域，且项目配置没有排除它。
 * @param input 静态校验的输入
 * @param excluded 全部候选的排除原因
 * @return 区域；没有这个操作时为 null
 */
function allowableZone(input: StaticCheckInput, excluded: CandidateExclusion[]): Zone | null {
  for (const item of excluded) {
    if (item.reason !== 'zone_blocked') continue;
    const zone = input.zoneOf(item.ref);
    if (zone !== null && (input.projectZones === null || input.projectZones.includes(zone))) return zone;
  }
  return null;
}

/**
 * @brief 模型全名里的提供商 id（第一个 / 之前）。
 * @param ref <provider>/<model>
 */
export function providerOf(ref: ModelRef): string {
  const slash = ref.indexOf('/');
  return slash < 0 ? ref : ref.slice(0, slash);
}

/**
 * @brief 会话启动的静态校验（§4.6）：先看角色文件的问题（agents_invalid，平行 Agent 规格 §4.4），再依次检查用户级配置、
 *        项目配置、有没有范围、范围是否存在，再按第 1–3 步过滤候选。
 * @param input 静态校验的输入
 * @return ModelState.blocked 与静态校验后的第一个候选
 */
export function staticCheck(input: StaticCheckInput): StaticCheckResult {
  if (input.agentProblems && input.agentProblems.length > 0) {
    const blocked = plainBlocked('agents_invalid', '', ['check_agents']);
    return { blocked: { ...blocked, problems: [...input.agentProblems] }, first: null };
  }
  if (input.configError !== null) {
    return { blocked: plainBlocked('config_invalid', input.configError, ['open_settings']), first: null };
  }
  if (input.projectError !== null) {
    return { blocked: plainBlocked('project_config', input.projectError, ['open_settings']), first: null };
  }
  if (input.pick === null) {
    return { blocked: plainBlocked('no_pick', '', modelActions(input)), first: null };
  }
  if (input.candidates === null) {
    return { blocked: plainBlocked('pick_missing', input.pick, modelActions(input)), first: null };
  }
  const result = selectStatic({ ...input, candidates: input.candidates });
  if (result.model !== null) return { blocked: null, first: result.model };
  return { blocked: candidateBlocked(input, result.excluded), first: null };
}

// ---- 顶栏菜单的各项（§9.2、§9.5 session.pickOptions） ----

/** @brief 顶栏菜单各项的输入：配置、项目配置的分组缩小，以及这个会话的第 1–3 步输入。 */
export interface PickOptionsInput extends Omit<StaticSelectorInput, 'candidates'> {
  /** 用户级配置 */
  config: Pick<ModelConfig, 'providers' | 'groups'>;
  /** 项目配置的 groups（已校验）；没有时省略 */
  projectGroups?: Readonly<Record<string, string[]>>;
}

/**
 * @brief 菜单的一项：展开后按第 1–3 步做静态校验；全部候选都被排除时 excluded 为真，reason 每个候选一行。
 * @param input 菜单各项的输入
 * @param item 这一项的选择范围、种类与文字
 */
function pickOption(input: PickOptionsInput, item: Pick<PickOption, 'pick' | 'kind' | 'label'>): PickOption {
  const candidates = expandPick(input.config, item.pick, input.projectGroups) ?? [];
  const used = new Set(candidates.map((ref) => input.zoneOf(ref)));
  const zones = ZONES.filter((zone) => used.has(zone));
  const result = selectStatic({ ...input, candidates });
  if (result.model !== null) return { ...item, zones, excluded: false, reason: null };
  const reason = result.excluded.map((exclusion) => `${exclusion.ref} — ${exclusion.detail}`).join('\n');
  return { ...item, zones, excluded: true, reason };
}

/**
 * @brief 顶栏菜单的各项（§9.2）：先全部分组（文字为 id），再全部提供商（文字为名称），再按提供商列出模型（文字为模型 id），
 *        各按配置里的顺序；每项标出展开后候选涉及的区域，全部候选都被本会话的静态校验排除时标为 excluded 并给出原因。
 * @param input 配置、项目配置的分组缩小与这个会话的第 1–3 步输入
 */
export function pickOptions(input: PickOptionsInput): PickOption[] {
  const { groups, providers } = input.config;
  const items: Pick<PickOption, 'pick' | 'kind' | 'label'>[] = [
    ...groups.map((group) => ({ pick: group.id, kind: 'group' as const, label: group.id })),
    ...providers.map((provider) => ({ pick: provider.id, kind: 'provider' as const, label: provider.name })),
    ...providers.flatMap((provider) => provider.models.map((model) => ({
      pick: `${provider.id}/${model.id}`, kind: 'model' as const, label: model.id }))),
  ];
  return items.map((item) => pickOption(input, item));
}

// ---- 候选耗尽（§5.8） ----

/** @brief 本段的范围：判断被排除的候选是否已在 tried 或 earlier 里（§5.8）。 */
export interface ReplyScope {
  /** 当前这段；没有段时省略 */
  reply?: ReplyState;
  /** 候选列表（判断 earlier 的先后） */
  candidates: readonly ModelRef[];
}

/**
 * @brief 会自己恢复、恢复后本段还会选的排除（§5.8）：原因在 RECOVERING_REASONS 里，且不在本段的 tried 或 earlier 里
 *        （选择器先报第 4 步的原因，所以本段已失败或排在 current 之前、此刻又不可用的候选也带着会恢复的原因）。
 * @param excluded 选不到时全部候选的排除原因
 * @param scope 本段；省略时不按 tried、earlier 过滤
 */
function recovering(excluded: readonly CandidateExclusion[], scope?: ReplyScope): CandidateExclusion[] {
  const reply = scope?.reply;
  const candidates = scope?.candidates ?? [];
  return excluded.filter((item) => RECOVERING_REASONS.has(item.reason)
    && !(reply && (reply.tried.has(item.ref) || isEarlier(candidates, reply, item.ref))));
}

/**
 * @brief 被排除的候选里有没有会自己恢复、恢复后本段还会选的（§5.8：只剩不会恢复的原因时不等）。
 * @param excluded 选不到时全部候选的排除原因
 * @param scope 本段；没有段时省略
 */
export function canRecover(excluded: readonly CandidateExclusion[], scope?: ReplyScope): boolean {
  return recovering(excluded, scope).length > 0;
}

/** @brief 候选耗尽时等待的输入。 */
export interface ExhaustionWaitInput {
  /** 选不到时全部候选的排除原因 */
  excluded: readonly CandidateExclusion[];
  /**
   * @brief 可用性快照，取恢复时刻（§8.3）。
   * @param ref 候选
   */
  availability(ref: ModelRef): Availability;
  /** 开始等待的时刻（ms） */
  waitStartedAt: number;
  /** 当前时刻（ms） */
  now: number;
  /** 时长表（§12） */
  timings: Pick<ModelTimings, 'exhaustionMaxWaitMs' | 'exhaustionRecheckMs'>;
  /** 本段（本段已在 tried 或 earlier 里的候选不算会恢复）；没有段时省略 */
  scope?: ReplyScope;
}

/** @brief 候选耗尽时的等待（§5.8）。 */
export interface ExhaustionWait {
  /** 最先恢复的那个候选及原因（阶段行“Waiting for a model · <原因>”） */
  first: CandidateExclusion;
  /** 它的恢复时刻；没有确定时刻（probing）时为 null */
  recoverAt: number | null;
  /** 下一次重新选的时刻：最早的恢复时刻、每隔重新选的间隔，以不超过最长等待为限 */
  recheckAt: number;
  /** 最长等到的时刻 */
  deadline: number;
}

/**
 * @brief 候选耗尽时是否继续等、等谁、何时重新选（§5.8）。探针结束时调用方另外重新选。
 * @param input 等待的输入
 * @return 等待；不等（没有会恢复的原因，或已等满最长时间）时为 null
 */
export function exhaustionWait(input: ExhaustionWaitInput): ExhaustionWait | null {
  const deadline = input.waitStartedAt + input.timings.exhaustionMaxWaitMs;
  if (input.now >= deadline) return null;
  const waiting = recovering(input.excluded, input.scope);
  if (waiting.length === 0) return null;
  let first = waiting[0];
  let recoverAt: number | null = null;
  for (const item of waiting) {
    if (item.reason === 'probing') continue;
    const availability = input.availability(item.ref);
    const until = availability.available ? null : availability.until;
    if (until !== null && (recoverAt === null || until < recoverAt)) {
      first = item;
      recoverAt = until;
    }
  }
  const nextTick = input.now + input.timings.exhaustionRecheckMs;
  const recheckAt = Math.max(input.now, Math.min(nextTick, recoverAt ?? nextTick, deadline));
  return { first, recoverAt, recheckAt, deadline };
}
