import assert from 'node:assert/strict';
import test from 'node:test';
import { initialSettings } from '../settings-catalog.js';
import { getModelPool, poolStatus, renderPool } from '../pool.js';

/** @brief 从实际演示配置建立独立测试状态。 */
function createState() {
  return { ...initialSettings(), phase: 'acceptance', poolState: 'normal', poolFilter: 'all',
    runtimeScenario: 'none', runtimeResolution: 'pending', session: 'coding',
    titles: { coding: 'Coding task', research: 'Research task' } };
}

/** @brief 核对全部容量都有已显示请求支撑，且每个服务只计算一次共享上限。 */
function assertCapacity(pool) {
  assert.equal(pool.active, pool.requests.filter(request => request.state === 'active').length);
  assert.equal(pool.queued, pool.requests.filter(request => request.state === 'queued').length);
  assert.equal(pool.capacity, pool.services.reduce((sum, service) => sum + service.capacity, 0));
  assert.equal(pool.available + pool.active, pool.capacity);
  for (const service of pool.services) {
    assert.equal(service.active, service.requests.filter(request => request.state === 'active').length);
    assert.equal(service.queued, service.requests.filter(request => request.state === 'queued').length);
    assert.equal(service.active + service.available, service.capacity);
    assert.ok(service.active <= service.capacity);
    assert.ok(service.requests.every(request => request.serviceId === service.id));
  }
}

test('fast and reasoning requests share one service capacity', () => {
  const state = createState();
  state.poolState = 'full';
  const pool = getModelPool(state);
  assertCapacity(pool);
  assert.equal(pool.capacity, 2);
  assert.equal(pool.active, 2);
  assert.equal(pool.available, 0);
  const activeModels = pool.requests.filter(request => request.state === 'active').map(request => request.modelKind);
  assert.deepEqual(new Set(activeModels), new Set(['fast', 'reasoning']));
});

test('acceptance preparation does not occupy a slot or report execution output', () => {
  const state = createState();
  const pool = getModelPool(state);
  const request = pool.requests.find(item => item.session === 'coding');
  assert.equal(request.role, '验收');
  assert.equal(request.state, 'pending');
  assert.equal(request.status, '准备独立验收');
  assert.equal(pool.active, 1);
  assert.equal(pool.queued, 0);
  assertCapacity(pool);
  state.phase = 'review';
  assert.equal(getModelPool(state).requests.find(item => item.session === 'coding').state, 'active');
  state.phase = 'completed';
  assert.ok(!getModelPool(state).requests.some(item => item.session === 'coding'));
});

test('capacity changes reallocate visible requests without manufacturing background work', () => {
  const state = createState();
  Object.assign(state, { phase: 'review', poolState: 'full' });
  for (const capacity of [1, 2, 4, 1000000]) {
    state.userSettings.models[0].concurrency = capacity;
    const pool = getModelPool(state);
    assertCapacity(pool);
    assert.equal(pool.requests.length, 3);
    assert.equal(pool.active, Math.min(capacity, 3));
    assert.equal(pool.queued, Math.max(3 - capacity, 0));
  }
  assert.equal(poolStatus(state).label, '模型池 · 正常');
});

test('model edits, disable and removal immediately update the pool', () => {
  const state = createState();
  const service = state.userSettings.models[0];
  Object.assign(service, { name: 'Updated service', fast: '<fast-v2>', reasoning: '<reasoning-v2>', concurrency: 3 });
  const pool = getModelPool(state);
  assert.equal(pool.services[0].name, 'Updated service');
  assert.equal(pool.capacity, 3);
  assert.deepEqual(pool.services[0].models.map(model => model.id), ['<fast-v2>', '<reasoning-v2>']);
  assert.ok(pool.requests.every(request => request.model === '<reasoning-v2>'));
  assert.ok(renderPool(state).includes('&lt;fast-v2&gt;'));
  assert.ok(renderPool(state).includes('&lt;reasoning-v2&gt;'));
  service.enabled = false;
  assert.deepEqual(getModelPool(state).requests, []);
  assert.equal(getModelPool(state).capacity, 0);
  assert.equal(poolStatus(state).label, '模型池 · 无启用服务');
  state.userSettings.models = [];
  assert.deepEqual(getModelPool(state).services, []);
  assert.equal(getModelPool(state).active, 0);
  assert.ok(renderPool(state).includes('没有已启用的模型服务'));
});

test('a second service contributes capacity once and does not invent active requests', () => {
  const state = createState();
  state.phase = 'review';
  state.userSettings.models[0].concurrency = 1;
  state.userSettings.models.push({ ...state.userSettings.models[0], id: 'second-service', concurrency: 4 });
  const pool = getModelPool(state);
  assertCapacity(pool);
  assert.equal(pool.capacity, 5);
  assert.equal(pool.active, 1);
  assert.equal(pool.queued, 1);
  assert.equal(pool.services[1].active, 0);
  assert.deepEqual(pool.services[1].requests, []);
  assert.equal(poolStatus(state).label, '模型池 · 有请求排队');
});

test('external waiting suppresses coding requests while research can continue', () => {
  const state = createState();
  state.phase = 'review';
  for (const scenario of ['login', 'unknown']) {
    for (const resolution of ['pending', 'not-executed']) {
      Object.assign(state, { runtimeScenario: scenario, runtimeResolution: resolution });
      const pool = getModelPool(state);
      assert.ok(!pool.requests.some(request => request.session === 'coding'));
      assert.ok(pool.requests.some(request => request.session === 'research' && request.state === 'active'));
      assertCapacity(pool);
    }
  }
  for (const resolution of ['verified', 'resumed', 'skipped']) {
    state.runtimeResolution = resolution;
    assert.ok(getModelPool(state).requests.some(request => request.session === 'coding'));
  }
});

test('missed maintenance during sleep does not block the coding task or run maintenance', () => {
  const state = createState();
  state.runtimeScenario = 'sleep';
  const pool = getModelPool(state);
  assert.equal(pool.requests.find(request => request.session === 'coding').state, 'pending');
  assert.ok(!pool.requests.some(request => request.session === 'maintenance'));
  state.phase = 'review';
  assert.equal(getModelPool(state).requests.find(request => request.session === 'coding').state, 'active');
});

test('sleep maintenance appears only after explicit resume and is not duplicated by background mode', () => {
  const state = createState();
  state.runtimeScenario = 'sleep';
  for (const mode of ['normal', 'full']) {
    state.poolState = mode;
    for (const resolution of ['pending', 'skipped']) {
      state.runtimeResolution = resolution;
      const pool = getModelPool(state);
      assert.ok(!pool.requests.some(request => request.session === 'maintenance'));
      assertCapacity(pool);
    }
    state.runtimeResolution = 'resumed';
    const pool = getModelPool(state);
    assert.equal(pool.requests.filter(request => request.session === 'maintenance').length, 1);
    assert.equal(pool.requests.find(request => request.session === 'maintenance').state, 'active');
    assertCapacity(pool);
  }
});

test('idle, stopped and retrying requests never count as active occupancy', () => {
  const state = createState();
  state.phase = 'review';
  for (const [scenario, requestState] of [['error', 'stopped'], ['warning', 'retry'], ['idle', null]]) {
    state.poolState = scenario;
    const pool = getModelPool(state);
    assertCapacity(pool);
    assert.equal(pool.active, 0);
    assert.equal(pool.available, pool.capacity);
    assert.ok(pool.requests.every(request => request.state === requestState));
    if (scenario === 'idle') assert.deepEqual(pool.requests, []);
  }
});
