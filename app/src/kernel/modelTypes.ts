// 模型层内核模块共用的类型（docs/specs/model-providers.md §5、§8；docs/specs/parallel-agents-taskboard.md §12）：
// 选择器、失败分类、模型池、会话接线之间的约定。
// 只有类型，没有运行时代码；界面也要看到的类型在 shared/models.ts。

import type { Capability, CandidateExclusion, ModelReason } from '../shared/models';

/** @brief 一个模型的全名 <provider>/<model>，第一个 / 之前是提供商（§1）。 */
export type ModelRef = string;

/** @brief 模型不可用的原因（§5.3 第 4 步、§8.3）。 */
export type AvailabilityReason = 'rate_limited' | 'auth' | 'quota' | 'connection' | 'not_found' | 'timeout' | 'held';

/** @brief 一个模型此刻是否可用（§8.3）；槽位满不算不可用。 */
export type Availability =
  | {
    /** 可用 */
    available: true;
  }
  | {
    /** 不可用 */
    available: false;
    /** 记录里最先恢复的原因 */
    reason: AvailabilityReason;
    /** 恢复时刻（ms）；不会自己恢复的（auth、quota、not_found）为 null */
    until: number | null;
  };

/** @brief 档案的 tool_calling 在选择时的状态（§5.3 第 3 步）：probing 只用于从未验证过、正在探测的模型（§7.4）。 */
export type ToolCallingState = 'verified' | 'unverified' | 'failed' | 'probing';

/** @brief 一段工作已失败、不再选的模型的原因（§5.2 tried）。 */
export interface TriedReason {
  /** 原因代码 */
  reason: ModelReason;
  /** 原因的细节 */
  detail: string;
}

/** @brief 一段工作（reply）的状态（§5.2）。 */
export interface ReplyState {
  /** 这段开始的时刻（ms），晚于上一段的全部消息（§11.4） */
  startedAt: number;
  /** 这段要回答的那条用户消息（anchor）的时间戳（ms）；还没有这条消息时为 null */
  anchorAt: number | null;
  /** 当前模型；还没选定时为 null */
  current: ModelRef | null;
  /** 本段里已失败、不再选的模型及原因 */
  tried: Map<ModelRef, TriedReason>;
  /** 段开始时排在 current 之前、被跳过的候选 */
  skipped: Set<ModelRef>;
}

/** @brief 选择器的输入（§5.3）。时刻由调用方给出（§12：纯函数以参数接收 now）。 */
export interface SelectorInput {
  /** 候选列表：选择范围按 §5.1 展开后的有序模型 */
  candidates: readonly ModelRef[];
  /**
   * @brief 名字是否在配置里（第 1 步）。
   * @param ref 候选
   */
  exists(ref: ModelRef): boolean;
  /** 回复进行中被删除的模型，排除文字用 "removed from your model settings"（§4.7）；没有时省略 */
  removedRefs?: ReadonlySet<ModelRef>;
  /**
   * @brief 档案的 tool_calling（第 3 步）；重新验证期间按旧结果。
   * @param ref 候选
   */
  toolCalling(ref: ModelRef): ToolCallingState;
  /**
   * @brief 可用性快照（第 4 步，§8.3）。
   * @param ref 候选
   */
  availability(ref: ModelRef): Availability;
  /**
   * 能力要求（第 3 步，平行 Agent 规格 §12.2）：tool_calling 总是先按 toolCalling 判断，其余各项按顺序逐项判断；
   * 省略时只有 tool_calling（普通会话）
   */
  requires?: readonly Requirement[];
  /**
   * @brief 第 3 步判断 tool_calling 以外的要求时用的档案能力；requires 只有 tool_calling 时不调用。
   * @param ref 候选
   */
  capabilities?(ref: ModelRef): ModelCapabilities;
  /** 要避开的模型族（第 3 步 same_family，平行 Agent 规格 §12.9）；省略或为空时不排除 */
  avoidFamilies?: ReadonlySet<string>;
  /**
   * @brief 候选的模型族（族为空时为 <provider>/<model> 本身，见 selector.familyKey）；avoidFamilies 不为空时调用。
   * @param ref 候选
   */
  familyOf?(ref: ModelRef): string;
  /** 当前这段工作；没有段时省略（只做第 1–4 步与选第一个） */
  reply?: ReplyState;
  /**
   * @brief 能否接手这段对话（第 6 步，§6.2），只在要换到它时调用；省略时不判断。
   * @param ref 要换到的候选
   * @return 能接手为 null；不能时给出 no_handover 的细节
   */
  handover?(ref: ModelRef): null | { detail: string };
  /** 当前时刻（ms） */
  now: number;
}

/** @brief 选择器的结果（§5.3）。 */
export interface SelectorResult {
  /** 选中的模型；选不到时为 null */
  model: ModelRef | null;
  /** 被排除的候选及第一个不满足的条件 */
  excluded: CandidateExclusion[];
}

/** @brief 一次 HTTP 尝试的失败分类（§5.4）；ok 为成功，aborted 为你按了停止。 */
export type FailureClass =
  | 'rate_limited' | 'auth' | 'quota' | 'not_found' | 'connection' | 'queue_timeout' | 'server' | 'timeout' | 'request'
  | 'partial' | 'aborted' | 'ok';

/** @brief 模型池记给包装的一次尝试（§8.4 第 5 步）。 */
export interface AttemptRecord {
  /** 尝试的模型 */
  ref: ModelRef;
  /** 用的 key 的 ref；没有 key 的提供商、或没拿到 key 就失败时为 null */
  keyRef: string | null;
  /** 分类 */
  cls: FailureClass;
  /** HTTP 状态；没有收到响应时为 null */
  status: number | null;
  /** Retry-After（秒数、HTTP 日期或 retry-after-ms）换算出的等待（ms）；没有时为 null */
  retryAfterMs: number | null;
  /** 这次请求已经收到正文、思考或工具调用的内容 */
  hadOutput: boolean;
  /** 真正发出的时刻（ms）；排队超时、不可用而没有发出时为 null */
  sentAt: number | null;
}

/**
 * @brief 模型池的调度类别（§8.2；平行 Agent 规格 §12.10），严格优先：conversation（对话会话、合并会话）
 *        > decision（分开时的立项、结案会话）> task（task 实例）> background（订阅、探针）；临时提问继承发送方的类别。
 *        排队超时只对 conversation、decision 生效。
 */
export type SchedClass = 'conversation' | 'decision' | 'task' | 'background';

/**
 * @brief 角色的一项能力要求（平行 Agent 规格 §4.1 requires、§12.2）：词表解析后的样子，选择器第 3 步逐项判定。
 */
export type Requirement =
  /** tool_calling：工具调用已验证（总是隐含） */
  | { kind: 'tool_calling' }
  /** protocol_write：交接写入已验证；min 为 B 时（protocol_write>=B）等级要 A 或 B，为 C 时任何等级都满足 */
  | { kind: 'protocol_write'; min: 'B' | 'C' }
  /** structured_output：结构化输出已验证 */
  | { kind: 'structured_output' }
  /** vision：图像输入，unverified 即满足 */
  | { kind: 'vision' }
  /** context>=N：有效窗口（没有档案时用配置的窗口）至少 tokens */
  | { kind: 'context'; tokens: number };

/**
 * @brief 选择器第 3 步判断能力要求用的档案字段（平行 Agent 规格 §12.2，统一模型提供商规格 §7.2）：
 *        有档案时按档案（重新探测期间仍是旧结果），没有档案时能力都未验证、窗口取配置的。
 */
export interface ModelCapabilities {
  /** 交接写入等级；没有档案或三级都没有通过时为 null */
  tier: 'A' | 'B' | 'C' | null;
  /** 交接写入（由 tier 派生） */
  protocolWrite: Capability;
  /** 结构化输出（anthropic-messages 总是 unverified） */
  structuredOutput: Capability;
  /** 图像输入：配置声明了为 unverified，否则 failed */
  vision: Capability;
  /** 有效窗口（token）；没有档案时为配置的窗口 */
  effectiveWindow: number;
  /** 这个模型正在探测：未验证的能力按 probing（会恢复）排除 */
  probing: boolean;
}

/**
 * @brief 会话的候选来源（平行 Agent 规格 §12.1）。
 *        pick：你在范围菜单里选的范围（普通会话与关闭模式下的对话会话）；
 *        role：角色的 models 依次展开、去重（为 null 时用会话的范围），within 给出时只留在它里面也有的、顺序按角色。
 */
export type CandidateSource =
  | {
    kind: 'pick';
    /** 能力要求：tool_calling ∪ 对话持有者的 requires；省略时只有 tool_calling */
    requires?: readonly Requirement[];
  }
  | {
    kind: 'role';
    /** 角色名：这个会话属于哪个角色（日志里注明） */
    role: string;
    /** 角色写的 models（有序的选择范围）；没写时为 null，用会话的范围 */
    models: readonly string[] | null;
    /** 能力要求：tool_calling ∪ 角色的 requires */
    requires: readonly Requirement[];
    /**
     * @brief 关闭模式下的临时提问：对话会话展开后的候选（ModelSession.candidateRefs），候选只留在它里面也有的；
     *        返回 null 时不限制。每次静态校验时调用。
     */
    within?: () => readonly ModelRef[] | null;
    /**
     * @brief differ_from: author 的角色：这个 task 全部交接的 authorFamilies（§12.9）；每次静态校验和每次选模型时调用，
     *        所以每次投递之前都按最新的交接重新计算。
     */
    avoidFamilies?: () => ReadonlySet<string>;
  };

/** @brief 候选耗尽、§5.8 等完仍选不到（ModelSessionOptions.onUnavailable 的参数，平行 Agent 规格 §12.5）。 */
export interface UnavailableInfo {
  /** 每个候选及排除原因 */
  candidates: CandidateExclusion[];
  /** 段开始时就选不到（这次投递没有发出） */
  firstRequest: boolean;
}

/** @brief task 会话中途换模型、要在新模型上重来（平行 Agent 规格 §12.4，ModelSession.takeRestart() 的结果）。 */
export interface TaskRestart {
  /** 原模型 */
  from: ModelRef;
  /** 新模型 */
  to: ModelRef;
  /** 换模型的原因代码 */
  reason: ModelReason;
  /** 原因的细节 */
  detail: string;
}
