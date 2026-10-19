import { getModelPool } from './pool.js';

/** @brief 初始化当前页面的运行场景，刷新与重置均不恢复真实任务。 */
export function initialRuntimeState() {
  return { runtimeScenario: 'none', runtimeResolution: 'pending', runtimeAgent: 'coding-main' };
}

/** @brief 判断编码任务的示例操作是否仍需登录或核对结果。 */
export function isRuntimeWaiting(state) {
  return ['login', 'unknown'].includes(state.runtimeScenario)
    && !['verified', 'resumed', 'skipped'].includes(state.runtimeResolution);
}

/** @brief 返回等待原因，操作结果未知不会被映射成任务成功。 */
export function runtimeWaitingReason(state) {
  if (!isRuntimeWaiting(state)) return '';
  if (state.runtimeScenario === 'unknown' && state.runtimeResolution === 'not-executed') {
    return '已核对未执行 · 等待明确重新执行';
  }
  return { login: '等待登录', unknown: '结果未知 · 等待核对' }[state.runtimeScenario];
}

/** @brief 切换预置演示场景，不把已完成的真实任务重新打开。 */
export function selectRuntimeScenario(state, scenario) {
  state.runtimeScenario = scenario;
  state.runtimeResolution = 'pending';
  state.phase = 'acceptance';
}

/** @brief 仅允许场景中可见的下一步，未知结果必须先核对才能演示重新执行。 */
export function resolveRuntimeScenario(state, action) {
  const scenario = state.runtimeScenario;
  const resolution = state.runtimeResolution;
  let next;
  if (scenario === 'login' && resolution === 'pending' && action === 'login') next = 'verified';
  if (scenario === 'unknown' && resolution === 'pending' && action === 'check') next = 'not-executed';
  if (scenario === 'unknown' && resolution === 'not-executed' && action === 'retry') next = 'verified';
  if (scenario === 'sleep' && resolution === 'pending' && action === 'resume') next = 'resumed';
  if (scenario === 'sleep' && resolution === 'pending' && action === 'skip') next = 'skipped';
  if (!next) {
    console.error('Invalid runtime scenario action.', { scenario, resolution, action });
    return false;
  }
  state.runtimeResolution = next;
  return true;
}

/** @brief 从同一演示任务和请求状态生成任务、进度及验收记录的不同文案。 */
export function codingTask(state) {
  if (state.phase === 'completed') {
    return { status: '已完成', progress: '独立验收已通过', evidence: '已通过', style: 'done' };
  }
  const reason = runtimeWaitingReason(state);
  if (reason) return { status: '等待', progress: reason, evidence: '待核对', style: 'pending' };
  if (state.phase === 'acceptance') {
    return { status: '待验收', progress: '准备独立验收', evidence: '待核对', style: 'pending' };
  }
  const pool = getModelPool(state);
  const request = pool.requests.find(item => item.session === 'coding');
  if (!request || request.state !== 'active') {
    const progress = pool.services.length ? '模型池空闲 · 暂无验收请求' : '等待配置模型服务';
    return { status: '等待', progress: request ? request.status : progress,
      evidence: '等待核对', style: 'pending' };
  }
  return { status: '待验收', progress: '独立验收中', evidence: '核对中', style: 'current' };
}

/** @brief 资料研究的聊天、任务和侧栏使用同一请求事实，停止或限流不显示正在响应。 */
export function researchTask(state) {
  const pool = getModelPool(state);
  const request = pool.requests.find(item => item.session === 'research');
  if (!request) {
    const progress = pool.services.length ? '模型池空闲 · 暂无检索请求' : '等待配置模型服务';
    return { status: '等待', progress, detail: '当前没有已提交的参考检索请求。' };
  }
  const active = request.state === 'active';
  return { status: active ? '执行中' : '等待', progress: `参考检索 · ${request.status}`,
    detail: active ? '请求已发出，正在约定等待时间内等待模型响应。' : request.waitingReason };
}

/** @brief 演示验收只有在请求正在运行时才能完成，等待场景不能绕过核对。 */
export function canAdvanceTask(state) {
  if (isRuntimeWaiting(state)) return false;
  return state.phase !== 'review' || codingTask(state).style === 'current';
}
