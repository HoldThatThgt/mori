// 记忆与增强的后台进程命令（docs/specs/memory.md §8）：memory.* 交给记忆模块（memory.ts），enhance.* 交给增强调度（enhance.ts）。
// 记忆页的写入一律以“你”写（by: You，没有工具调用方、没有增强运行）。失败都放在结果的 error 里（只有原因，不带动词前缀），
// 不让命令本身失败；文字字段的长度由记忆模块按 §10.1 的句子查。

import type { MemoryWriteResult } from '../shared/memory';
import type { Command } from '../shared/protocol';
import { enhanceInfo, runNow, setEnhance, type EnhancePatch } from './enhance';
import { forget, get, list, move, revision, revisions, rollback, save, update, type MemoryActor } from './memory';

/** 记忆页的写入方（§6.1）：你，没有工具调用方，不属于增强运行 */
const PAGE_ACTOR: MemoryActor = Object.freeze<MemoryActor>({ by: 'You', caller: null, run: null });
/** 放回本项目、提升却没有工作目录（同记忆页 Project 不可用时的悬停文字，§10.1；memory.ts 的同一句） */
const NO_PROJECT = 'Open a session to see this project’s memory.';

/** @brief memory.save 的命令。 */
type SaveCommand = Extract<Command, { type: 'memory.save' }>;
/** @brief memory.move 的命令。 */
type MoveCommand = Extract<Command, { type: 'memory.move' }>;
/** @brief enhance.set 的命令。 */
type EnhanceSetCommand = Extract<Command, { type: 'enhance.set' }>;

/**
 * @brief memory.save（§8）：没有 id 时新增（source user，不要依据）；有 id 时修改那一条（修订说明固定为
 *        `Edited on the Memory page`，§3.2）。成功时 id 为这一条的 id。
 */
async function saveEntry(command: SaveCommand): Promise<MemoryWriteResult> {
  const { cwd, layer, kind, abstract, detail } = command;
  if (command.id === undefined) return save(PAGE_ACTOR, { cwd, layer, kind, abstract, detail, evidence: [] });
  const result = await update(PAGE_ACTOR, { target: { cwd, layer, kind, id: command.id }, abstract, detail, note: '' });
  return result.error === null ? { ...result, id: command.id } : result;
}

/** @brief memory.move（§8）：from project 提升到用户级，from user 放回本项目；都要有工作目录。 */
async function moveEntry(command: MoveCommand): Promise<MemoryWriteResult> {
  if (command.cwd === null) {
    console.error(`[kernel] memory.move of ${command.id} refused: no project`);
    return { error: NO_PROJECT, revision: null, id: null };
  }
  return move(PAGE_ACTOR, command.cwd, command.from, command.id);
}

/** @brief enhance.set 的改动部分（去掉命令类型与工作目录）。 */
function enhancePatch(command: EnhanceSetCommand): EnhancePatch {
  const { type, cwd, ...patch } = command;
  return patch;
}

/**
 * @brief 记忆与增强的命令（§8），由 commands.ts 在会话命令之前交来。
 * @param command 已经过 zod 校验的命令
 * @return 结果；不是 memory.* 或 enhance.* 时为 undefined
 */
export async function handleMemoryCommand(command: Command): Promise<unknown | undefined> {
  switch (command.type) {
    case 'memory.list': return list(command.cwd, command.layer, command.kind);
    case 'memory.get': return get(command.cwd, command.layer, command.id);
    case 'memory.save': return saveEntry(command);
    case 'memory.delete':
      return forget(PAGE_ACTOR, { target: { cwd: command.cwd, layer: command.layer, id: command.id }, note: '' });
    case 'memory.move': return moveEntry(command);
    case 'memory.revisions':
      return command.id === undefined ? revisions(command.cwd, command.layer)
        : revision(command.cwd, command.layer, command.id);
    case 'memory.rollback': return rollback(PAGE_ACTOR, command.cwd, command.layer, command.id);
    case 'enhance.get': return enhanceInfo(command.cwd);
    case 'enhance.set': return setEnhance(command.cwd, enhancePatch(command));
    case 'enhance.run': return runNow(command.cwd);
    default: return undefined;
  }
}
