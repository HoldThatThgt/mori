// 实例会话（docs/specs/parallel-agents-taskboard.md §3、§8.1、§8.2、§14.1、§14.5）：一个角色正在用的一条 pi 会话。
// 会话文件在 <userData>/teams/<用户会话 id>/sessions 下（不在 <agentDir>/sessions，侧栏与会话列表都不列它们），
// 头部的 parentSession 指向用户会话的文件，第一条条目是 mori.instance。实例沿用用户会话的信任结果（不再询问）与批准状态，
// 扩展的询问不出卡，批准请求交给 Team；pi 事件与模型层事件交给 Team，不发给界面。
// 这里是实例与用户会话不同的部分；建立、转发、投递与停止都走会话表（sessions.ts）的同一条路径。

import { join } from 'node:path';
import type { SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { EventEnvelope } from '../shared/protocol';
import { TEAM_ENTRY_TYPES } from '../shared/team';
import { instanceSeats } from './memoryAssemble';
import type { Pi } from './pi';
import type { SessionSetup } from './sessions';
import type { InstanceSpec } from './teamHost';

/** 每个用户会话的 TaskBoard 目录的上一级：<userData>/teams（§3）；后台进程收到主进程的 start 之前为 null */
let teamsRoot: string | null = null;

/**
 * @brief 主进程送来 userData 后记下 TaskBoard 的根目录（§3）。
 * @param userData Electron 的 userData 目录
 */
export function setUserData(userData: string): void {
  teamsRoot = join(userData, 'teams');
}

/**
 * @brief 一个用户会话的 TaskBoard 目录：<userData>/teams/<用户会话 id>（board.json 与 sessions/ 在这里）。
 * @param userSessionId 用户会话的 pi 会话 id
 */
export function teamDirOf(userSessionId: string): string {
  if (teamsRoot === null) throw new Error('The Mori data folder is not known yet');
  return join(teamsRoot, userSessionId);
}

/**
 * @brief 新建实例会话的 SessionManager（§8.2、§14.5）：SessionManager.create(cwd, 目录, { id, parentSession })，
 *        在 pi 建会话（写 model_change 等条目）之前写下第一条 mori.instance；第一条用户或助手消息之后 pi 才写盘。
 * @param pi pi 模块
 * @param spec 实例的设置
 */
export function newInstanceManager(pi: Pi, spec: InstanceSpec): SessionManager {
  const manager = pi.SessionManager.create(spec.cwd, spec.dir,
    { id: spec.id, parentSession: spec.parentSession ?? undefined });
  manager.appendCustomEntry(TEAM_ENTRY_TYPES.instance, spec.instance);
  return manager;
}

/** @brief 实例会话的信封事件不发给界面（§8.2）：pi 事件经 onEvent、模型层事件经 onModelEvent 交给 Team。 */
export function instanceEnvelope(envelope: EventEnvelope): void {
  void envelope;
}

/**
 * @brief 建实例会话要用的、与用户会话不同的部分（§8.2）：工具白名单、附加段、mori-team、沿用的信任与批准状态、
 *        批准扩展的 GateOutput（除 send 外都在这里：请求 id 的前缀 `<实例 id>:`、工作路径、种类、卡片所在的用户会话、
 *        交给 Team 的批准回调与“这次运行已经交接”，docs/specs/file-system-permissions.md §9.2）、交给 Team 的 pi 事件；
 *        记忆设置与按种类定下的身份（docs/specs/memory.md §5.1、§9.6）；mori-snapshots 标出的 Agent（Team 给的角色与 task，
 *        docs/specs/file-system.md §4.5）。
 * @param spec 实例的设置
 * @param settings 这个实例自己的 SettingsManager（pi 的设置与加载器不能在会话之间共用，§14.1）
 * @param sessionId 实例的 pi 会话 id（重新打开时取会话文件头部的 id）
 */
export function instanceSetup(spec: InstanceSpec, settings: SettingsManager, sessionId: string): SessionSetup {
  return {
    kind: spec.kind, owner: spec.owner, trust: spec.trust, approval: spec.approval, settings,
    gate: { prefix: `${sessionId}:`, cwd: spec.cwd, kind: spec.kind, userSessionId: spec.owner,
      onRequest: (request) => spec.onApprovalRequest({ ...request, instance: sessionId }),
      onEnd: (end) => spec.onApprovalEnd(end),
      handedOff: () => spec.handedOff() },
    teamExtension: spec.teamExtension, appendPrompt: spec.appendPrompt, tools: spec.tools,
    onEvent: (event) => spec.onEvent(event),
    memory: spec.memory, seats: () => instanceSeats(spec.kind),
    runAgent: () => spec.runAgent(),
  };
}
