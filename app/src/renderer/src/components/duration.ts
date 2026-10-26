// 工具卡、阶段行与 subagent 卡共用的秒数文字（docs/v0/screens/tool-cards.md）；纯函数，不依赖组件。

/** @brief 秒数文字：10 秒以内带一位小数（"1.5s"、"3s"），之后取整（"12s"）。 */
export function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s` : `${Math.round(ms / 1000)}s`;
}
