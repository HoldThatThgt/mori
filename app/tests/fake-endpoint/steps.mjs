// 合成测试端点（synthetic）脚本模式的步骤构造函数：scripts.mjs 与 scenarios/ 下各套件的场景文件共用
// （格式见 scripts.mjs 开头）。

/** end() 的回复 */
export const END_TEXT = 'Stopping here without a handoff.';

/** @brief 一个回复步骤：items 为 { say } | { call } | { handoff } 的有序列表；waitMs、fails 是修饰。 */
const response = (items) => ({ items, waitMs: 0, fails: [] });
/** @brief 只回文字。 */
export const say = (text) => response([{ say: text }]);
/** @brief 调用一个工具；args 里的字符串可以用模板。 */
export const call = (name, args = {}) => response([{ call: { name, args } }]);
/** @brief 回 END_TEXT 就结束，不交接。 */
export const end = () => say(END_TEXT);
/**
 * @brief 交接单，按请求的形状（A/B/C）输出。
 * @param fields 交接单字段（task_handoff 或 request_close 的参数名），字符串可以用模板
 * @param opts { malformed：输出程序用不了的截断 JSON 或标签 }
 */
export const handoff = (fields, { malformed = false } = {}) => response([{ handoff: { fields, malformed } }]);
/** @brief 修饰：第一个分块前多等 ms 毫秒。 */
export const wait = (ms) => ({ items: [], waitMs: ms, fails: [] });
/**
 * @brief 修饰：以 status 返回错误。
 * @param opts { model：只在请求的模型 id 等于它时失败；不写时总是失败 }
 */
export const fail = (status, { model = null } = {}) => ({ items: [], waitMs: 0, fails: [{ status, model }] });

/** @brief 几个步骤合成一个回复：文字与调用按顺序，等待相加，失败条件都保留。 */
export function together(...steps) {
  return {
    items: steps.flatMap((s) => s.items),
    waitMs: steps.reduce((sum, s) => sum + s.waitMs, 0),
    fails: steps.flatMap((s) => s.fails),
  };
}
