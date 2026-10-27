// 合成测试端点（synthetic）脚本模式的步骤构造函数：scripts.mjs 与 scenarios/ 下各套件的场景文件共用
// （格式见 scripts.mjs 开头）。

/** end() 的回复 */
export const END_TEXT = 'Stopping here without a handoff.';

/**
 * @brief 一个回复步骤：items 为 { say } | { think } | { call } | { handoff } | { line } 的有序列表；waitMs、fails 是修饰；
 *        when（可选）是行的名字：请求里没有这一行时这一步不算；unless（可选）相反：请求里有这一行时这一步不算；
 *        whenDelivery、unlessDelivery（可选，文件系统第 3 步加）按最后一次投递里的文字决定这一步算不算。
 */
const response = (items) => ({ items, waitMs: 0, fails: [] });
/** @brief 只回文字。 */
export const say = (text) => response([{ say: text }]);
/** @brief 一段思考（reasoning_content，在文字与调用之前流出）；单独用时只有思考、没有文字，通常与 say、call 合成一个回复。 */
export const think = (text) => response([{ think: text }]);
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
 * @param opts { model：只在请求的模型 id 等于它时失败；不写时总是失败, retryAfter：响应头 Retry-After 的秒数（不写时没有） }
 */
export const fail = (status, { model = null, retryAfter = null } = {}) => ({ items: [], waitMs: 0,
  fails: [{ status, model, retryAfter }] });

/**
 * @brief 按行值回复（文件系统第 1 步加，规则见 scripts.mjs 开头）：请求的 user 消息里 "<key>: <步骤>" 一行的步骤，
 *        按关键词的单步写法（replies.mjs parseStep，开头的 [wait <毫秒>]、[fail-once <状态码>] 照样生效）；
 *        请求里没有这一行时这一步不算。
 * @param key 行的名字，例如 fs-call
 * @param opts { last：只在最后一次投递里找（不看更早的消息与工作卡）；不写时找全部 user 消息 }
 */
export const line = (key, { last = false } = {}) => ({ items: [{ line: key, last }], waitMs: 0, fails: [], when: key,
  whenLast: last });
/**
 * @brief 按行值的一串步骤（文件系统第 2 步加，规则见 scripts.mjs 开头）：请求的 user 消息里 "<key>: <步骤> ;; <步骤> …"
 *        一行按 " ;; " 分开，每一段占一个回复位置（第 i 段回答这个位置上的请求），每段按关键词的单步写法
 *        （replies.mjs parseStep，开头的 [wait]、[fail-once] 照样生效）；请求里没有这一行时一个位置也不占。
 *        只能单独作为一项，不能放进 together；修饰（wait、fail）写在它前面时修饰第一段。
 * @param key 行的名字，例如 git-task
 * @param opts { last：同 line }
 */
export const chain = (key, { last = false } = {}) => ({ items: [{ chain: key, last }], waitMs: 0, fails: [] });
/**
 * @brief 修饰：请求里有 "<key>: " 这一行时才有这一步，没有时这一步不算（不占位置）；作用于整个步骤，
 *        与 together 合用时写 when(key, together(…))。
 * @param opts { last：同 line }
 */
export const when = (key, step, { last = false } = {}) => ({ ...step, when: key, whenLast: last });
/**
 * @brief 修饰，与 when 相反：请求里没有 "<key>: " 这一行时才有这一步，有这一行时这一步不算（不占位置）。
 *        同一个位置的两种做法写成 when(key, a) 与 unless(key, b) 两项，恰好一项算数，后面步骤的位置不变；
 *        与 together 合用时同样写 unless(key, together(…))。
 * @param opts { last：同 line }
 */
export const unless = (key, step, { last = false } = {}) => ({ ...step, unless: key, unlessLast: last });
/**
 * @brief 修饰（文件系统第 3 步加）：最后一次投递（去掉工作卡）含 texts 里任一段文字时才有这一步，否则这一步不算
 *        （不占位置）。用来在每次投递都一样的步骤列表里分开投递的种类，例如强制填写的投递（含 "Hand it off now."）
 *        只交接，普通的投递照常做事；可以与 when、unless 叠加（各自的条件都要满足）。
 * @param texts 一段文字或几段文字的数组
 */
export const whenDelivery = (texts, step) => ({ ...step, whenDelivery: [texts].flat() });
/** @brief 修饰，与 whenDelivery 相反：最后一次投递含 texts 里任一段文字时这一步不算。 */
export const unlessDelivery = (texts, step) => ({ ...step, unlessDelivery: [texts].flat() });

/** @brief 几个步骤合成一个回复：文字与调用按顺序，等待相加，失败条件都保留。 */
export function together(...steps) {
  return {
    items: steps.flatMap((s) => s.items),
    waitMs: steps.reduce((sum, s) => sum + s.waitMs, 0),
    fails: steps.flatMap((s) => s.fails),
  };
}
