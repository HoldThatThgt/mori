/** @brief 从已启用模型服务建立共享容量视图。 */
function configuredServices(state) {
  return state.userSettings.models.filter(item => item.enabled).map(item => ({
    id: item.id, name: item.name, capacity: item.concurrency, active: 0, queued: 0,
    available: item.concurrency,
    models: [{ kind: 'fast', id: item.fast }, { kind: 'reasoning', id: item.reasoning }],
    requests: [],
  }));
}

/** @brief 创建明确归属服务和模型的示例请求。 */
function createRequest(service, role, session, modelKind) {
  return { id: `${service.id}-${session}`, role, session, serviceId: service.id,
    model: service.models.find(model => model.kind === modelKind).id, modelKind,
    state: 'pending', status: '准备独立验收', waitingReason: '等待推进独立验收演示' };
}

/** @brief 判断编码任务是否仍在等待外部处理。 */
function codingWaiting(state) {
  return ['login', 'unknown'].includes(state.runtimeScenario) &&
    !['verified', 'resumed', 'skipped'].includes(state.runtimeResolution);
}

/** @brief 生成有限的演示工作，准备验收不表示已发起模型请求。 */
function requestedWork(state, service) {
  if (state.poolState === 'idle') return [];
  const requests = [createRequest(service, '参考检索', 'research', 'reasoning')];
  if (!codingWaiting(state) && ['acceptance', 'review'].includes(state.phase)) {
    requests.push(createRequest(service, '验收', 'coding', 'reasoning'));
  }
  const maintenanceResumed = state.runtimeScenario === 'sleep' && state.runtimeResolution === 'resumed';
  const maintenanceRequested = state.poolState === 'full' && state.runtimeScenario !== 'sleep';
  if (maintenanceRequested || maintenanceResumed) {
    requests.push(createRequest(service, '工作回顾', 'maintenance', 'fast'));
  }
  return requests;
}

/** @brief 为单个请求记录展示状态及其原因。 */
function setRequestState(request, status, label, reason) {
  request.state = status;
  request.status = label;
  request.waitingReason = reason;
}

/** @brief 按同一服务的共享上限分配示例请求，不增加未显示的占用。 */
function scheduleRequests(state, service) {
  for (const request of service.requests) {
    if (request.session === 'coding' && state.phase === 'acceptance') continue;
    if (state.poolState === 'error') {
      setRequestState(request, 'stopped', '已停止', '演示认证失败，需要更新认证后明确恢复');
    } else if (state.poolState === 'warning') {
      setRequestState(request, 'retry', '等待重试', '演示服务限流，等待重试期限');
    } else if (service.active < service.capacity) {
      setRequestState(request, 'active', request.session === 'research' ? '等待响应' : '输出中', '');
      service.active += 1;
    } else {
      setRequestState(request, 'queued', '排队中', '所属模型服务的共享槽位已满');
      service.queued += 1;
    }
  }
  service.available = service.capacity - service.active;
}

/**
 * @brief 汇总用户设置中的模型服务和同一批演示请求，供模型池及请求轨迹共同展示。
 * @param {Object} state 当前页面状态。
 * @returns {Object} 服务、请求和共享容量；待发起、重试和停止的请求不占槽位。
 */
export function getModelPool(state) {
  const services = configuredServices(state);
  if (services.length) {
    services[0].requests = requestedWork(state, services[0]);
    scheduleRequests(state, services[0]);
  }
  return { services, requests: services.flatMap(service => service.requests),
    capacity: services.reduce((sum, service) => sum + service.capacity, 0),
    active: services.reduce((sum, service) => sum + service.active, 0),
    queued: services.reduce((sum, service) => sum + service.queued, 0),
    available: services.reduce((sum, service) => sum + service.available, 0) };
}
