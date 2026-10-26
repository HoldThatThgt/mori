// 合成端点（synthetic）的脚本：tests/ui/mem-app-tool.mjs 用（docs/specs/memory.md §14.1、MEM-10、MEM-15），格式见
// scripts.mjs 开头；名字以 mem-tool- 开头。只用于测试，不是真实模型的行为。
// 'mem-tool-split'：分开配置（chat 持有对话，planner 持有立项与结案，正文带 tb-scenario:mem-tool-split）。
//   关闭模式下先聊一句（chat 的 off-dialog 回一句话）；然后 /team 的一条消息：分开时的立项实例先用 memory save 记一条
//   事实（agent 调用方，依据的 entry 应为 null，§7.3），再 reply_via_dialog（不需要协作），对话转述一句。
// 'mem-tool-live'：关闭模式、没有角色的项目（基座 mori），第一条用户消息带 tb-scenario:mem-tool-live。第一次投递：主 Agent
//   先 memory save 记一条事实（依据是这一轮的你的消息），再等 waitMs 才回一句；第二次投递：等 waitMs 再回一句。
//   测会话还在生成时 Jump to source 能找到依据（§8 session.read 的 anchor，§10.2）。
// 这里另外导出套件要比较的文字（MEM_TOOL_SPLIT、MEM_TOOL_LIVE），scripts.mjs 只并入 SCENARIOS。

import { call, say, wait } from '../steps.mjs';

/** 套件要比较的文字 */
export const MEM_TOOL_SPLIT = {
  /** 关闭模式的第一条消息（会话名取它）与对话的回答 */
  warmup: 'plain split warm-up',
  warmupReply: 'Warm-up noted.',
  /** /team 的消息、立项记下的事实与原话 */
  message: 'Please note that the build server is build-07',
  abstract: 'The build server is build-07',
  quote: 'the build server is build-07',
  /** 立项交给对话的说明与对话的回答 */
  note: 'Nothing to do; the fact was saved',
  relayed: 'Noted: the build server is build-07.',
};

/** 'mem-tool-live' 里套件要比较的文字 */
export const MEM_TOOL_LIVE = {
  /** 第一条消息（会话名取它）：主 Agent 记下的事实与原话 */
  message: 'tb-scenario:mem-tool-live Please note that the release branch is release-42',
  abstract: 'The release branch is release-42',
  quote: 'the release branch is release-42',
  /** 第二条消息 */
  second: 'Keep drafting the release notes',
  /** 每一轮最后的回答，回答之前等 waitMs（这期间会话在生成） */
  reply: 'Finished after a long wait.',
  waitMs: 25000,
};

/** @brief mem-tool-live 的两次投递：先记事实再久等着回答；只久等着回答。 */
const live = {
  1: [call('memory', { action: 'save', kind: 'fact', abstract: MEM_TOOL_LIVE.abstract, quote: MEM_TOOL_LIVE.quote,
    asked: true }),
    wait(MEM_TOOL_LIVE.waitMs), say(MEM_TOOL_LIVE.reply)],
  2: [wait(MEM_TOOL_LIVE.waitMs), say(MEM_TOOL_LIVE.reply)],
};

/** @brief 对话（chat）每次投递都回同一句（关闭模式的第 1 次、协作模式的之后几次）。 */
const relay = { 1: [say(MEM_TOOL_SPLIT.warmupReply)], 2: [say(MEM_TOOL_SPLIT.relayed)],
  3: [say(MEM_TOOL_SPLIT.relayed)] };

export const SCENARIOS = {
  'mem-tool-split': [
    { role: 'planner', kind: 'create', deliveries: {
      1: [call('memory', { action: 'save', kind: 'fact', abstract: MEM_TOOL_SPLIT.abstract,
        quote: MEM_TOOL_SPLIT.quote, asked: true }),
      call('reply_via_dialog', { note: MEM_TOOL_SPLIT.note }), say('Saved the fact; no task needed.')],
    } },
    { role: 'chat', kind: 'off-dialog', deliveries: relay },
    { role: 'chat', kind: 'dialog', deliveries: relay },
    { role: 'chat', kind: 'team-dialog', deliveries: relay },
  ],
  'mem-tool-live': [
    { role: 'mori', kind: 'dialog', deliveries: live },
    { role: 'mori', kind: 'off-dialog', deliveries: live },
  ],
};
