// 拼装器（docs/specs/memory.md §5.1、§7.2、§7.6）：会话的身份（主 Agent、席位、subagent）→ 四种条目里拿哪几种，
// 以及这个会话有没有 memory 工具、作为哪个调用方。纯函数；分节的文字由 memoryText.ts 的 memorySections 给出，
// 写进 system prompt 由 mori-memory（memoryExtension.ts）在每次运行开始时做。

import { SECTION_ORDER, type EnhanceTask, type MemoryCaller, type MemoryKind } from '../shared/memory';
import type { InstanceKind, TeamMode } from '../shared/team';

/** @brief 会话的身份（§1、§5.1）：主 Agent、对话、立项、结案、subagent。合并会话兼任对话与立项。 */
export type SessionSeat = 'main' | 'dialog' | 'create' | 'close' | 'sub';

/** 分发表（§5.1）：每种身份拿哪几种条目 */
const SEAT_KINDS: Readonly<Record<SessionSeat, readonly MemoryKind[]>> = Object.freeze({
  main: ['taste', 'strategy', 'review', 'fact'],
  dialog: ['taste'],
  create: ['taste', 'strategy', 'fact'],
  close: ['review'],
  sub: ['strategy', 'review'],
});

/**
 * @brief 一个会话这次运行拿到的种类（§5.1）：各身份那一行的并集（proposal §5.1“兼任按会话取并集”），按分节的写入顺序。
 * @param seats 这次运行的身份
 */
export function kindsFor(seats: ReadonlySet<SessionSeat>): MemoryKind[] {
  return SECTION_ORDER.filter((kind) => [...seats].some((seat) => SEAT_KINDS[seat].includes(kind)));
}

/**
 * @brief 用户会话（含增强会话本身）这次运行的身份（§5.1）。没有 Team（含角色文件有问题、agents_invalid）或模式为 off 时
 *        是主 Agent；模式不为 off 时，合并会话兼任对话与立项，分开时只是对话。
 * @param mode 这次运行的协作模式；没有 Team 时为 null
 * @param merged Team 是否为合并会话（Team.merged）
 */
export function userRunSeats(mode: TeamMode | null, merged: boolean): Set<SessionSeat> {
  if (mode === null || mode === 'off') return new Set<SessionSeat>(['main']);
  return new Set<SessionSeat>(merged ? ['dialog', 'create'] : ['dialog']);
}

/**
 * @brief 实例会话的身份（§5.1）：立项、结案各自一行；task、临时提问（含关闭模式的）、订阅都是 subagent。
 * @param kind 实例的种类
 */
export function instanceSeats(kind: InstanceKind): Set<SessionSeat> {
  if (kind === 'create') return new Set<SessionSeat>(['create']);
  if (kind === 'close') return new Set<SessionSeat>(['close']);
  return new Set<SessionSeat>(['sub']);
}

/**
 * @brief 这个会话有没有 memory 工具、作为哪个调用方（§7.2、§7.6、§0 第 1 条），在会话建立时定下。
 *        用户会话（含增强会话本身）总是注册：协作模式分开时不启用由 team.ts 决定（§7.6），所以与这次的身份无关。
 *        实例会话：立项有；增强会话的 Team 里 task 实例（含只读 task）也有；结案、临时提问、订阅没有。
 * @param seats 会话的身份（实例会话为 instanceSeats 的结果）
 * @param enhance 增强会话（及它的实例）所属的任务；普通会话为 null
 * @param instanceKind 实例会话的种类；用户会话为 null
 * @return 调用方；没有这个工具时为 null
 */
export function memoryCallerFor(seats: ReadonlySet<SessionSeat>, enhance: EnhanceTask | null,
  instanceKind: string | null): MemoryCaller | null {
  const caller: MemoryCaller = enhance === null ? { kind: 'agent' } : { kind: 'enhance', task: enhance };
  if (instanceKind === null) return caller;
  if (seats.has('create')) return caller;
  if (enhance !== null && instanceKind === 'task') return caller;
  return null;
}
