// 数字的界面写法（docs/v1/screens/models-settings.md "模型行"）：纯函数，模型行、模型行的提示（modelHints.ts，单元测试
// 直接测）与 AGENTS.md 的 token 数共用一份。2026-10-26（WP-15）从 common.tsx 移来，modelHints.ts 不必载入 React 组件。

/** @brief 数字按千分位写（models-settings.md "模型行"）。 */
export function thousands(value: number): string {
  return value.toLocaleString('en-US');
}
