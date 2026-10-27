// 收尾检查（docs/specs/finish-check.md §1、§2）里内核与界面共用的常量：工具名、检查那一行的条目种类与开头。
// 界面不能 import kernel/，所以放在 shared。合成端点（tests/fake-endpoint/scripts.mjs）自留一份 CHECK_LINE_HEAD，
// 单元测试比对两边相等（§14.2 FC-26）。

/** @brief 确认最终回复的工具名（§4）：没有参数，结果带 terminate；界面按这个名字不画它（§10.1）。 */
export const FINISH_TOOL = 'finish';

/** @brief 检查那一行的 custom_message 条目种类（§1、§5.5）：存进会话文件，display 为 false。 */
export const FINISH_CHECK_TYPE = 'mori.finish_check';

/** @brief 检查那一行的开头（§7.1）：合成端点、模型层认 pi-ai 形状的检查那一行都按它。只给模型看，撇号照原样。 */
export const CHECK_LINE_HEAD = "[Mori] This is Mori's end-of-turn check";
