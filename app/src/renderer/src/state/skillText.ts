// 技能调用的识别（docs/v0/screens/slash.md "发出之后"）：pi 把"/skill:名字 参数"展开成
// <skill name="名字" location="SKILL.md 路径">\n正文\n</skill>，有参数时空一行接参数（agent-session.js _expandSkillCommand）。
// 对话流照 pi 终端（parseSkillBlock、SkillInvocationMessageComponent）缩成一行；会话名按"/skill:名字 参数"算。

/** @brief 你的消息里的一次技能调用。 */
export interface SkillInvocation {
  /** 技能名 */
  name: string;
  /** SKILL.md 的路径 */
  location: string;
  /** 技能正文（含 pi 加的"References are relative to …"一行） */
  body: string;
  /** 你写的参数；没有时为空串 */
  args: string;
}

/** pi parseSkillBlock 的正则（agent-session.js 53–63）；渲染进程不引入 pi 的运行时代码，照抄 */
const SKILL_BLOCK = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** @brief 识别技能调用；不是 pi 展开的技能命令时为 null。 */
export function parseSkillInvocation(text: string): SkillInvocation | null {
  const match = SKILL_BLOCK.exec(text);
  if (!match) return null;
  return { name: match[1], location: match[2], body: match[3], args: match[4]?.trim() ?? '' };
}

/** @brief 会话名用的文字：技能调用写回"/skill:名字 参数"，其他消息原样返回。 */
export function skillCommandText(text: string): string {
  const skill = parseSkillInvocation(text);
  if (!skill) return text;
  return skill.args ? `/skill:${skill.name} ${skill.args}` : `/skill:${skill.name}`;
}
