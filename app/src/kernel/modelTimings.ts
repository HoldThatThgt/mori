// 模型层的时长与次数（docs/specs/model-providers.md §12；docs/specs/parallel-agents-taskboard.md §15；
// docs/specs/model-discovery.md §11，登记在 docs/v1/defaults.md）。
// 纯函数以参数接收 ModelTimings，测试可以传入缩短的值。

import { MODEL_LIMITS } from '../shared/models';

/** @brief 模型层用到的全部时长（毫秒）、次数与上限。 */
export interface ModelTimings {
  /**
   * conversation、decision 类别排队等槽位的最长时间，超过即 queue_timeout；task、background 不超时
   * （§8.2，平行 Agent 规格 §12.10）
   */
  readonly queueTimeoutMs: number;
  /**
   * 每个 key 给 conversation、decision 留的槽位：task、background 在一个 key 上最多占（并发上限 − 它）个、至少 1 个，
   * 所以并发上限为 1 时不留（平行 Agent 规格 §12.10、§15）
   */
  readonly reservedSlots: number;
  /** 429 没有 Retry-After 时 key 的冷却时间（§5.4） */
  readonly rateLimitCooldownMs: number;
  /** 连接失败后提供商不可用的时间（§5.4） */
  readonly connectionCooldownMs: number;
  /** 5xx 原地重试每次等待的时间，按顺序；重试次数即数组长度（§5.5） */
  readonly serverRetryDelaysMs: readonly number[];
  /** 一次尝试发出后等第一个有内容的事件的时限（§5.4 timeout） */
  readonly firstContentTimeoutMs: number;
  /** 超时后、已验证断开即停止的模型不可用的时间（§5.7 timeout） */
  readonly timeoutCooldownMs: number;
  /** 超时后不能确认停止的模型等它停下的最长时间（§5.7 held） */
  readonly heldMs: number;
  /** held 期间读服务端指标确认停下的间隔（§5.7） */
  readonly heldPollMs: number;
  /** 候选耗尽时最长等待的时间（§5.8） */
  readonly exhaustionMaxWaitMs: number;
  /** 候选耗尽时重新选的间隔（§5.8） */
  readonly exhaustionRecheckMs: number;
  /** 探针请求的最大输出 token（§7.3） */
  readonly probeMaxTokens: number;
  /** 取消探针（第 9 步）长输出请求的最大输出 token（§7.3） */
  readonly probeCancelMaxTokens: number;
  /** 探针每一步等第一个有内容的事件的时限（§7.3） */
  readonly probeStepTimeoutMs: number;
  /** C 级文本标签探针（第 7 步）连发的次数（§7.3） */
  readonly tierCRepetitions: number;
  /** 长输入探针（第 8 步）填充到有效窗口的比例，按顺序（§7.3） */
  readonly longInputFractions: readonly number[];
  /** 取消探针（第 9 步）断开后等进行中请求数回落的时间（§7.3） */
  readonly cancelProbeWindowMs: number;
  /**
   * 发现与读服务信息的每个请求的时限（连接到读完响应体）：models.discover、探针第 0 步、读版本共用
   * （model-discovery.md §5.3、§7.1、§11）
   */
  readonly discoverRequestTimeoutMs: number;
  /** 4xx、5xx 响应体最多读的字节数（§8.4） */
  readonly errorBodyMaxBytes: number;
  /** 注册到 pi 的占位 apiKey，不保密；真正的 key 由模型池写进认证头（§4.4、§8.4） */
  readonly placeholderApiKey: string;
  /** 新提供商每个 key 的并发上限（§4.1） */
  readonly concurrencyDefault: number;
  /** 并发上限的最小值（§4.1） */
  readonly concurrencyMin: number;
  /** 并发上限的最大值（§4.1） */
  readonly concurrencyMax: number;
  /** 每个提供商最多的 key 数（§4.1） */
  readonly maxKeys: number;
}

/**
 * @brief §12 的临时默认值（发现请求的时限见 model-discovery.md §11）；并发与 key 数的上限与 shared/models.ts 的
 *        配置校验共用一份。
 */
export const MODEL_TIMINGS: ModelTimings = Object.freeze({
  queueTimeoutMs: 60_000,
  reservedSlots: 1,
  rateLimitCooldownMs: 30_000,
  connectionCooldownMs: 30_000,
  serverRetryDelaysMs: Object.freeze([2_000, 4_000, 8_000]),
  firstContentTimeoutMs: 120_000,
  timeoutCooldownMs: 60_000,
  heldMs: 120_000,
  heldPollMs: 5_000,
  exhaustionMaxWaitMs: 60_000,
  exhaustionRecheckMs: 5_000,
  probeMaxTokens: 256,
  probeCancelMaxTokens: 2_048,
  probeStepTimeoutMs: 120_000,
  tierCRepetitions: 3,
  longInputFractions: Object.freeze([0.5, 0.9]),
  cancelProbeWindowMs: 5_000,
  discoverRequestTimeoutMs: 15_000,
  errorBodyMaxBytes: 64 * 1024,
  placeholderApiKey: 'mori-pool',
  concurrencyDefault: MODEL_LIMITS.concurrencyDefault,
  concurrencyMin: MODEL_LIMITS.concurrencyMin,
  concurrencyMax: MODEL_LIMITS.concurrencyMax,
  maxKeys: MODEL_LIMITS.maxKeys,
});
