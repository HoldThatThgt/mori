// 合成测试端点（synthetic）用到的文件系统第 1 步（权限）的文字：ask_user_question 的参数预设与“你不在”的提醒
// （docs/specs/file-system.md §14，docs/specs/file-system-permissions.md §9.8、§10.2）。只用于测试，不是真实模型的行为。
// 关键词 "ask user: <预设>"（replies.mjs）与脚本里 line 步骤的同一写法按 ASK_PRESETS 调用 ask_user_question；
// App 套件 import ASK_PRESETS 比较卡上的问题与工具结果。REMINDER_PREFIX 是提醒的第一行：关键词模式下最后一条是提醒时
// 回 REMINDER_ACK 加清单的第一项；脚本模式下提醒不算投递（scripts.mjs），模型对它的回复是同一次投递的下一步。

/** 提醒的第一行（§14“提醒”；custom_message 作为 user 消息发给模型，§9.8） */
export const REMINDER_PREFIX = '[Mori] The user was away, so Mori decided these without them during this turn:';
/** 关键词模式下对提醒的回复的开头（后面接清单的第一项） */
export const REMINDER_ACK = 'Noted the reminder:';

/** @brief 一段文字是不是提醒（开头的空白不算）。 */
export const isReminder = (text) => typeof text === 'string' && text.trimStart().startsWith(REMINDER_PREFIX);

/** §14 的例子：单选的数据库问题（推荐 PostgreSQL） */
const DB = {
  question: 'Which database should I use?',
  header: 'Database',
  options: [{ label: 'PostgreSQL', description: 'Server database' }, { label: 'SQLite', description: 'Single file' }],
  multiSelect: false,
  recommended: 'PostgreSQL',
};

/** §14 的例子：多选的范围问题（工具卡标题 Ask · Database, Scope） */
const PARTS = {
  question: 'Which parts?',
  header: 'Scope',
  options: [{ label: 'API', description: 'The HTTP API' }, { label: 'CLI', description: 'The command line' },
    { label: 'Web', description: 'The web page' }],
  multiSelect: true,
  recommended: 'API',
};

/** @brief 第 n 个两选一的问题（four 预设用：四个问题，各两项）。 */
const pick = (n) => ({
  question: `Question number ${n}: which option?`,
  header: `Pick ${n}`,
  options: [{ label: `Option ${n}A`, description: `First choice of question ${n}` },
    { label: `Option ${n}B`, description: `Second choice of question ${n}` }],
  multiSelect: false,
  recommended: `Option ${n}B`,
});

/**
 * ask_user_question 的参数预设：名字 → questions（调用的参数为 { questions }）。前四个合法；bad- 开头的在执行时
 * 校验不过（§14“提问的校验错误”，isError、不出卡）：bad-recommended 的第 2 题推荐 MySQL、bad-other 有 Other 选项、
 * bad-same 两个选项同名。
 */
export const ASK_PRESETS = {
  db: [DB],
  parts: [PARTS],
  'db-parts': [DB, PARTS],
  four: [pick(1), pick(2), pick(3), pick(4)],
  'bad-recommended': [PARTS, { ...DB, recommended: 'MySQL' }],
  'bad-other': [{ ...DB, options: [...DB.options, { label: 'Other', description: 'Something else' }] }],
  'bad-same': [{ ...DB, options: [DB.options[0], { label: 'postgresql', description: 'Same name' }] }],
};

/** @brief 按预设拼出 ask_user_question 的参数（深拷贝）；没有这个预设时为 null。 */
export function askArgs(name) {
  return Object.hasOwn(ASK_PRESETS, name) ? { questions: structuredClone(ASK_PRESETS[name]) } : null;
}
