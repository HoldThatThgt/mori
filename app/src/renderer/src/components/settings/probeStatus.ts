// 模型行上 tool calling 的状态（docs/specs/model-providers.md §7.4、§9.1；docs/v1/screens/models-settings.md
// “Models 行”的状态行，2026-10-26 负责人走查 M7）：行上的 data-probe 与一行状态。纯函数，ModelRows.tsx 用，单元测试
// （tests/unit/modelRows.test.mjs）直接测。

import type { ProfileView } from '../../../../shared/models';

/**
 * @brief 行上的 data-probe（给界面测试读）：从未验证过的（没有档案，或档案里不是 verified、failed，例如上次出错）探测中为
 *        verifying，验证过的重新探测为 reverifying；否则为档案的 tool_calling.state，没有档案又不在探测时为 unverified。
 * @param profile 这个模型的档案；没有时为 null
 * @param running 这个模型正在探测（mori.profiles 的 running 里有它）
 */
export function probeState(profile: ProfileView | null, running: boolean): string {
  const state = profile?.tool_calling.state;
  const verified = profile !== null && profile.status !== 'probing' && (state === 'verified' || state === 'failed');
  if (running && verified) return 'reverifying';
  if (running || profile?.status === 'probing') return 'verifying';
  return state ?? 'unverified';
}

/** @brief 状态行：验证中、验证失败（第 3、4 步判定为不通过）或探针出错（tool calling 因出错没有验证）。 */
export interface StatusLine {
  /** data-state：verifying、failed、error */
  state: 'verifying' | 'failed' | 'error';
  /** 一行文字 */
  text: string;
}

/**
 * @brief 状态行（models-settings.md “Models 行”）：只在模型不能用时有，即 tool calling 没验证通过（选择器第 3 步按它排除，
 *        §5.3），或从没完成过验证。tool calling 验证通过的模型（重新验证中、其他步出错的）没有状态行。
 *        没有档案又不在探测（探针抛错、档案没建成、探针没能开始，后台进程都记了错误日志）时同探针出错：“Couldn’t verify”
 *        加 Verify again，不一直写 Verifying…（保存后、启动时探针都在界面读到档案之前开始，不会闪一下）。
 * @param profile 这个模型的档案；没有时为 null
 * @param running 这个模型正在探测
 * @return 状态行；能用的模型为 null
 */
export function statusLine(profile: ProfileView | null, running: boolean): StatusLine | null {
  if (profile !== null && profile.status !== 'probing' && profile.tool_calling.state === 'verified') return null;
  if (running || profile?.status === 'probing') return { state: 'verifying', text: 'Verifying…' };
  if (profile?.tool_calling.state === 'failed') {
    const { call, result } = profile.tool_calling;
    const detail = [call, result].find((step) => step.outcome === 'fail')?.detail;
    return { state: 'failed', text: `Tool calling failed verification${detail ? `: ${detail}` : ''}` };
  }
  return { state: 'error', text: `Couldn’t verify${profile?.error ? `: ${profile.error}` : ''}` };
}
