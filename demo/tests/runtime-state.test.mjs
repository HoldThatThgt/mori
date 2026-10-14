import test from 'node:test';
import assert from 'node:assert/strict';
import { initialSettings } from '../settings-catalog.js';
import { renderRuntimePanel } from '../runtime-panel.js';
import { initialRuntimeState, selectRuntimeScenario, resolveRuntimeScenario } from '../task-state.js';
import { codingTask, researchTask, canAdvanceTask, isRuntimeWaiting } from '../task-state.js';

/** @brief 创建不访问浏览器或网络的演示状态。 */
function fixture() {
  return { ...initialSettings(), ...initialRuntimeState(), phase: 'acceptance', poolState: 'normal',
    session: 'coding', titles: { coding: 'Coding', research: 'Research' } };
}

test('unknown results require verification before one explicit retry', t => {
  const state = fixture();
  selectRuntimeScenario(state, 'unknown');
  assert.equal(codingTask(state).status, '等待');
  assert.equal(canAdvanceTask(state), false);
  assert.doesNotMatch(renderRuntimePanel(state), /data-resolution="retry"/);
  const errors = t.mock.method(console, 'error', () => {});
  assert.equal(resolveRuntimeScenario(state, 'retry'), false);
  assert.equal(state.runtimeResolution, 'pending');
  assert.equal(resolveRuntimeScenario(state, 'check'), true);
  assert.equal(canAdvanceTask(state), false);
  assert.match(renderRuntimePanel(state), /data-resolution="retry"/);
  assert.equal(resolveRuntimeScenario(state, 'retry'), true);
  assert.equal(codingTask(state).status, '待验收');
  assert.equal(resolveRuntimeScenario(state, 'retry'), false);
  assert.equal(errors.mock.calls.length, 2);
});

test('login completion releases only the affected example task', () => {
  const state = fixture();
  selectRuntimeScenario(state, 'login');
  assert.equal(isRuntimeWaiting(state), true);
  assert.equal(canAdvanceTask(state), false);
  assert.equal(resolveRuntimeScenario(state, 'login'), true);
  assert.equal(canAdvanceTask(state), true);
  assert.match(renderRuntimePanel(state), /登录检查已完成/);
});

test('missed maintenance requires a choice without blocking the coding task', () => {
  for (const action of ['resume', 'skip']) {
    const state = fixture();
    selectRuntimeScenario(state, 'sleep');
    assert.equal(state.runtimeResolution, 'pending');
    assert.equal(codingTask(state).status, '待验收');
    assert.equal(canAdvanceTask(state), true);
    assert.equal(resolveRuntimeScenario(state, action), true);
    assert.equal(state.runtimeResolution, action === 'resume' ? 'resumed' : 'skipped');
  }
});

test('queued or stopped acceptance cannot finish until the request is active', () => {
  const state = fixture();
  state.phase = 'review';
  state.userSettings.models[0].concurrency = 1;
  assert.equal(codingTask(state).status, '等待');
  assert.equal(canAdvanceTask(state), false);
  assert.doesNotMatch(renderRuntimePanel(state), /独立读取文件和示例测试记录/);
  state.userSettings.models[0].concurrency = 2;
  assert.equal(canAdvanceTask(state), true);
  for (const poolState of ['warning', 'error', 'idle']) {
    state.poolState = poolState;
    assert.equal(canAdvanceTask(state), false);
    assert.equal(codingTask(state).status, '等待');
  }
  state.userSettings.models = [];
  assert.equal(canAdvanceTask(state), false);
});

test('completed evidence stays complete despite unrelated model failures', () => {
  const state = fixture();
  state.phase = 'completed';
  state.poolState = 'error';
  assert.equal(codingTask(state).status, '已完成');
  assert.equal(codingTask(state).evidence, '已通过');
});

test('research status distinguishes active response, rate limits, stop and no service', () => {
  const state = fixture();
  assert.equal(researchTask(state).status, '执行中');
  for (const poolState of ['warning', 'error', 'idle']) {
    state.poolState = poolState;
    assert.equal(researchTask(state).status, '等待');
    assert.doesNotMatch(researchTask(state).progress, /等待响应/);
  }
  assert.match(researchTask(state).progress, /空闲/);
  state.userSettings.models = [];
  assert.match(researchTask(state).progress, /配置模型服务/);
});

test('other user sessions never inherit coding agents or tool calls', () => {
  const state = fixture();
  for (const session of ['research', 'new-session']) {
    state.session = session;
    const html = renderRuntimePanel(state);
    assert.doesNotMatch(html, /data-agent="coding-/);
    assert.doesNotMatch(html, /data-file-id="dispatch"/);
    assert.doesNotMatch(html, /id="runtime-scenario"/);
  }
  assert.match(renderRuntimePanel(state), /暂无运行记录/);
});
