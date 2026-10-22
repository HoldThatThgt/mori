// 模型层内核模块共用的类型（docs/specs/model-providers.md §5、§8）：选择器、失败分类、模型池、会话接线之间的约定。
// 只有类型，没有运行时代码；界面也要看到的类型在 shared/models.ts。

import type { CandidateExclusion, ModelReason, Zone } from '../shared/models';

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
   * @brief 候选的提供商所在区域（第 2 步）。
   * @param ref 候选
   * @return 区域；区域未确认时为 null
   */
  zoneOf(ref: ModelRef): Zone | null;
  /** 项目允许的区域（§4.3 三步的结果） */
  allowedZones: readonly Zone[];
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

/** @brief 模型池的调度类别（§8.2）：conversation 严格先于 background。 */
export type SchedClass = 'conversation' | 'background';
