// team.test.mjs 与 flow.test.mjs 共用的测试会话表（synthetic TeamHost）：内存里的 pi SessionManager，运行由测试一步步
// 发出 pi 事件；对话的回复（dialogStart）记下来，由测试决定何时开始、何时结束，准备中可以被停止（docs/specs/
// parallel-agents-taskboard.md §5.3、§8.2、§11.4）。不连模型，也不起 Electron。文件名不以 .test.mjs 结尾，node --test 不单独运行它。

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { loadKernelModule } from '../load.mjs';

export const TeamModule = await loadKernelModule('src/kernel/team.ts');
export const B = await loadKernelModule('src/kernel/board.ts');
export const roles = await loadKernelModule('src/kernel/roles.ts');

export const deps = { pickExists: () => true, parseFrontmatter };
/** planner 持有立项与结案，chat 持有对话（分开时），executor、reviewer（synthetic）。 */
export const SPLIT = roles.parseRoleFiles([
  { file: '.mori/agents/chat.md', text: '---\nname: chat\ndescription: Talks to you\nseats: [dialog]\n---\n' },
  { file: '.mori/agents/executor.md', text: '---\nname: executor\ndescription: Changes code\n---\nMORI-ROLE-executor' },
  { file: '.mori/agents/planner.md', text: '---\nname: planner\ndescription: Plans\nseats: [create, close]\n---\n' },
  { file: '.mori/agents/reviewer.md', text: '---\nname: reviewer\ndescription: Reviews\ntools: [read]\n---\n' },
], deps);
assert.deepEqual(SPLIT.problems, []);

/** 写入等级为 level 的模型档案（synthetic）；level 为 null 时没有等级。 */
export function profile(level) {
  const step = (outcome) => ({ outcome, detail: null });
  return { tier: { level, a: step('fail'), b: step('fail'), c: step(level === 'C' ? 'pass' : 'not_run') },
    reasoning: { can_disable: false } };
}

/** 一条会话的模型层（只有 Team 用到的部分，synthetic）；state.blocked 为真时会话被拒绝启动。 */
function fakeModel(state) {
  return {
    state: () => ({ current: 'fake/model', pick: 'strong' }),
    layer: { profileOf: () => state.profile, familyOf: (ref) => ref },
    takeRestart: () => {
      const restart = state.restart ?? null;
      state.restart = null;
      return restart;
    },
    candidateRefs: () => ['fake/model'],
    outsideRefs: () => state.outside ?? [],
    setTeamLock: async (locked) => {
      state.locks = [...(state.locks ?? []), locked];
      return {};
    },
    isBlocked: () => state.blocked === true,
  };
}

/** 记下注册的工具与处理器的扩展 API（synthetic）。 */
function fakeApi() {
  const tools = new Map();
  const handlers = new Map();
  let active = ['read', 'bash', 'edit', 'write'];
  return {
    tools, handlers,
    registerTool: (def) => tools.set(def.name, def),
    on: (event, handler) => handlers.set(event, handler),
    getAllTools: () => [...['read', 'bash', 'edit', 'write'], ...tools.keys()].map((name) => ({ name })),
    getActiveTools: () => [...active],
    setActiveTools: (names) => { active = [...names]; },
  };
}

/**
 * 对话的一次回复（synthetic dialogStart）：进入准备中，before 等完（或被停止）后由测试开始运行；
 * resolve 兑现 dialogStart（同 deliver 的投递记录，runDelivery 可以直接用）。
 */
function dialogReply(host, id, item, before) {
  const entry = host.entries.get(id);
  const controller = new AbortController();
  entry.running = true;
  entry.preparing = true;
  let resolve = () => undefined;
  const done = new Promise((settle) => {
    resolve = settle;
  });
  const record = { id, text: item.text, item, controller, resolve, aborted: false };
  record.ready = (before ? before(controller.signal) : Promise.resolve()).then(() => {
    record.aborted = controller.signal.aborted;
  });
  host.dialogs.push(record);
  return { record, done };
}

/** 会话表（synthetic）：实例与用户会话都是内存里的 pi 会话；投递与对话的回复等测试发出运行。 */
export function fakeHost(state) {
  const entries = new Map();
  const host = {
    entries, events: [], deliveries: [], answers: [], aborts: [], dialogs: [], queued: [],
    newEntry(id, cwd, spec) {
      const api = fakeApi();
      const entry = { id, spec, api, running: false, preparing: false, cwd, sessionFile: join(cwd, `${id}.jsonl`),
        session: { sessionManager: SessionManager.inMemory(cwd), extensionRunner: { getCommand: (name) =>
          (state.commands ?? []).includes(name) ? { name } : undefined }, promptTemplates: state.templates ?? [] },
        model: fakeModel(state) };
      if (spec) spec.teamExtension(api);
      entries.set(id, entry);
      return entry;
    },
    async createInstance(spec) { host.newEntry(spec.id, spec.cwd, spec); return spec.id; },
    async openInstance(file, spec) { host.newEntry(spec.id, spec.cwd, spec); return spec.id; },
    async closeInstance(id) { entries.delete(id); },
    deliver(id, text, choice) {
      return new Promise((resolve) => host.deliveries.push({ id, text, choice, resolve }));
    },
    dialogStart(id, item, before) {
      return dialogReply(host, id, item, before).done;
    },
    dialogQueue(id, item, behavior) { host.queued.push({ id, text: item.text, behavior }); },
    async abort(id, reason) {
      host.aborts.push({ id, reason });
      const reply = host.dialogs.findLast((item) => item.id === id && entries.get(id)?.preparing);
      if (!reply) return;
      reply.controller.abort();
      await reply.ready;
      entries.get(id).preparing = false;
      entries.get(id).running = false;
      reply.resolve();
    },
    answerApproval(id, requestId, decision) { host.answers.push({ id, requestId, decision }); return true; },
    status(id) {
      const entry = entries.get(id);
      return entry ? { running: entry.running, preparing: entry.preparing, stop: null } : null;
    },
    entry(id) { return entries.get(id) ?? null; },
    emitUser(_id, event) { host.events.push(event); },
  };
  return host;
}

/** 等一个条件成立（Team 写出 board.json、唤醒与调度都是异步的）。 */
export async function until(check, what) {
  for (let i = 0; i < 200; i += 1) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * 建一个用户会话的 Team（分开时的角色；用户会话 U）。
 * @param load 角色
 * @param level 写入等级
 * @param extra state 的其他项（commands、templates、blocked）与 restored、prepareUser（打开前往用户会话里写条目）
 */
export async function setup(load = SPLIT, level = null, extra = {}) {
  const state = { profile: level === undefined ? null : profile(level), ...extra };
  const host = fakeHost(state);
  const cwd = mkdtempSync(join(tmpdir(), 'mori-team-'));
  const team = TeamModule.createTeam(host, { userSessionId: 'U', userSessionFile: null, cwd, roles: load,
    teamDir: join(cwd, 'teams', 'U'), baseTools: ['read', 'bash', 'edit', 'write'], trust: {}, approval: {},
    restored: extra.restored === true });
  const user = host.newEntry('U', cwd, null);
  user.spec = { onEvent: (event) => team.onUserEvent(event), model: {} };
  await extra.prepareUser?.(user, cwd);
  team.userExtension()(user.api);
  await team.attachUser({ sessionId: 'U', session: user.session, model: user.model });
  return { team, host, user, state, cwd };
}

/** 登记需求 1 并建一个指派给 assignee 的 task（立项的写入，直接调用 board.ts）。 */
export function addTask(team, over = {}) {
  if (!B.findRequest(team.board, 1)) {
    team.write((board) => B.submitRequest(board, { title: 'Login page is blank', goal: 'Fix it', acceptance: null,
      quote: null }, { message: 'fix the login page', history: [] }, Date.now()));
  }
  return team.write((board) => B.createTask(board, { request: 1, title: 'Find and fix', description: 'Fix it',
    assignee: 'executor', readOnly: false, dependsOn: [], ...over }, Date.now())).task;
}

/** 文字消息。 */
export const text = (role, value) => ({ role, content: [{ type: 'text', text: value }], timestamp: Date.now() });

/**
 * 一次运行（synthetic）：发 agent_start、投递的 user 消息、每个助手回复（文字或工具调用，工具结果经 tool_result 钩子），
 * 最后 agent_settled 并兑现投递。返回每个工具结果。
 */
export async function runDelivery(host, delivery, replies) {
  await beginRun(host, delivery);
  return finishRun(host, delivery, replies);
}

/** 一条 role 为 user 的消息进入会话：message_start（mori-team 的处理器）、写进会话、message_end。 */
export function userMessage(entry, value) {
  const prompt = text('user', value);
  entry.api.handlers.get('message_start')?.({ type: 'message_start', message: prompt });
  entry.spec.onEvent({ type: 'message_start', message: prompt });
  entry.session.sessionManager.appendMessage(prompt);
  entry.spec.onEvent({ type: 'message_end', message: prompt });
  return prompt;
}

/** 运行开始：agent_start 与投递的 user 消息。 */
export async function beginRun(host, delivery) {
  const entry = host.entry(delivery.id);
  entry.running = true;
  entry.preparing = false;
  entry.api.handlers.get('before_agent_start')?.({ type: 'before_agent_start', systemPromptOptions: { sections: {} } });
  entry.spec.onEvent({ type: 'agent_start' });
  userMessage(entry, delivery.text);
  await Promise.resolve();
}

/** 运行的助手回复，然后 agent_settled 并兑现投递。 */
export async function finishRun(host, delivery, replies) {
  const entry = host.entry(delivery.id);
  const results = [];
  for (const reply of replies) results.push(...await assistantTurn(entry, reply));
  entry.running = false;
  entry.spec.onEvent({ type: 'agent_settled' });
  delivery.resolve();
  return results;
}

let callNo = 0;

/** 一条助手回复：文字，或一批工具调用（TaskBoard 工具执行它的定义，其余工具的结果由测试给出）。 */
export async function assistantTurn(entry, reply) {
  const sm = entry.session.sessionManager;
  entry.spec.model.shape?.({ ref: 'fake/model', api: 'openai-completions', context: { messages: [] } });
  const calls = (reply.calls ?? []).map((call) => ({ type: 'toolCall', id: `call-${++callNo}`, name: call.name,
    arguments: call.args ?? {} }));
  const message = { role: 'assistant', content: [...(reply.text ? [{ type: 'text', text: reply.text }] : []), ...calls],
    provider: 'fake', model: 'model', stopReason: calls.length ? 'toolUse' : 'stop', timestamp: Date.now(),
    api: 'openai-completions', usage: {} };
  entry.spec.onEvent({ type: 'message_start', message });
  sm.appendMessage(message);
  entry.spec.onEvent({ type: 'message_end', message });
  const results = [];
  for (const [index, call] of calls.entries()) {
    const given = reply.calls[index];
    results.push(await toolCall(entry, call, given.result));
  }
  return results;
}

/** 一次工具调用：tool_call 处理器（拒绝时带 terminate），执行，tool_result 处理器（证据编号），写进会话。 */
async function toolCall(entry, call, given) {
  const sm = entry.session.sessionManager;
  entry.spec.onEvent({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments });
  const blocked = entry.api.handlers.get('tool_call')?.({ type: 'tool_call', toolCallId: call.id, toolName: call.name,
    input: call.arguments });
  let result;
  if (blocked?.block) {
    result = { content: [{ type: 'text', text: blocked.reason }], isError: true, terminate: blocked.terminate };
  } else if (entry.api.tools.has(call.name)) {
    const def = entry.api.tools.get(call.name);
    result = await def.execute(call.id, def.prepareArguments(call.arguments), undefined, undefined, {});
  } else {
    result = { content: [{ type: 'text', text: given ?? 'ok' }], isError: false };
  }
  const changed = blocked?.block ? undefined : entry.api.handlers.get('tool_result')?.({ type: 'tool_result',
    toolCallId: call.id, toolName: call.name, input: call.arguments, content: result.content, isError: !!result.isError,
    details: undefined });
  const content = changed?.content ?? result.content;
  sm.appendMessage({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content, isError: !!result.isError,
    timestamp: Date.now() });
  entry.spec.onEvent({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name,
    isError: !!result.isError });
  return { ...result, content };
}

/** 等某个会话的下一次投递。 */
export function nextDelivery(host, id, after = 0) {
  return until(() => host.deliveries.slice(after).find((item) => item.id === id), `a delivery to ${id}`);
}

/** 等对话的下一次回复（dialogStart）。 */
export function nextDialog(host, after = 0) {
  return until(() => host.dialogs[after], 'a dialog reply');
}

/** 一次做完的交接：先跑一个命令，再以 outcome 交接（done、pass 要有证据）。 */
export function workThen(outcome, over = {}) {
  return [{ calls: [{ name: 'bash', args: { command: 'npm test' }, result: 'ok' }] },
    { calls: [{ name: 'task_handoff', args: { conclusion: 'Fixed.', outcome, evidence: ['#1'], ...over } }] }];
}
