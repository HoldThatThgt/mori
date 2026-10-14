import { icon } from './icons.js';
import { escapeHtml } from './feedback.js';
import { getModelPool } from './model-pool.js';

/** @brief 导出模型池与请求轨迹共同使用的服务和请求视图。 */
export { getModelPool };

/** @brief 生成绑定用户会话和实际示例模型的请求行。 */
function requestRow(request, state) {
  const title = request.session === 'maintenance' ? '整理沟通与纠正' : state.titles[request.session];
  const action = request.session === 'maintenance' ? 'show-maintenance' : `session-${request.session}`;
  const queued = request.state === 'active' ? '' : 'queued';
  return `<button class="request-row" data-action="${action}">
    <span class="request-role">${request.role.slice(0, 1)}</span><span class="request-content">
    <span class="request-title">${request.role} · ${escapeHtml(title)}</span>
    <div class="request-meta">${escapeHtml(request.model)} · 独立上下文</div>
    ${request.waitingReason ? `<div class="request-meta">${request.waitingReason}</div>` : ''}</span>
    <span class="request-status ${queued}">${request.status}</span></button>`;
}

/** @brief 依据已显示请求和共享容量返回模型池的文字和颜色。 */
export function poolStatus(state) {
  const pool = getModelPool(state);
  if (!pool.services.length) return { label: '模型池 · 无启用服务', dot: 'idle', detail: '请配置并启用模型服务' };
  const detail = `共享槽位 · ${pool.active} / ${pool.capacity} · 排队 ${pool.queued}`;
  if (state.poolState === 'error') return { label: '模型池 · 已停止', dot: 'error', detail };
  if (state.poolState === 'warning') return { label: '模型池 · 限流', dot: 'warning', detail };
  if (!pool.active) return { label: '模型池 · 空闲', dot: 'idle', detail };
  if (!pool.available) return { label: '模型池 · 共享槽位已满', dot: 'full', detail };
  if (pool.queued) return { label: '模型池 · 有请求排队', dot: 'full', detail };
  return { label: '模型池 · 正常', dot: '', detail };
}

/** @brief 显示模型标识和活动请求数，不为同一服务重复创建容量。 */
function modelSummary(model, requests) {
  const active = requests.filter(request => request.modelKind === model.kind && request.state === 'active').length;
  const role = model.kind === 'fast' ? '快速模型' : '推理模型';
  return `<p class="popover-subtitle">${role} · ${escapeHtml(model.id)} ·
    ${active ? `${active} 个活动请求` : '暂无活动请求'}</p>`;
}

/** @brief 以服务为单位展示共享容量和归属请求，会话筛选不改变全局容量。 */
function serviceSection(service, state) {
  const requests = service.requests.filter(request =>
    state.poolFilter !== 'current' || request.session === state.session);
  const dot = service.active === service.capacity ? 'full' : service.active ? '' : 'idle';
  return `<div class="pool-section"><div class="pool-heading"><span class="dot ${dot}"></span>
    <strong>${escapeHtml(service.name)}</strong><span>${service.active} / ${service.capacity} 占用</span></div>
    <p class="popover-subtitle">服务共享上限 ${service.capacity} · 可用 ${service.available} · 排队 ${service.queued}</p>
    ${service.models.map(model => modelSummary(model, service.requests)).join('')}
    ${requests.length ? requests.map(request => requestRow(request, state)).join('')
      : '<p class="popover-subtitle">当前筛选下暂无请求。</p>'}</div>`;
}

/** @brief 显示故障演示的事实，不声称真实接口已经连接。 */
function scenarioNotice(state) {
  if (state.poolState === 'error') return '<div class="pool-error">演示：服务返回 401，已提交请求停止。</div>';
  if (state.poolState === 'warning') return '<div class="pool-error">演示：服务返回 429，请求等待重试。</div>';
  return '';
}

/** @brief 提供有限演示工作的切换入口，是否满载由配置和请求共同决定。 */
function scenarioOptions(state) {
  return [['normal', '正常请求'], ['full', '背景请求参与'], ['warning', '服务限流'],
    ['error', '错误停止'], ['idle', '空闲']].map(([value, label]) =>
    `<option value="${value}" ${value === state.poolState ? 'selected' : ''}>演示：${label}</option>`).join('');
}

/** @brief 展示用户设置中的服务和共享容量，请求只属于当前页面演示。 */
export function renderPool(state) {
  const pool = getModelPool(state);
  const services = pool.services.map(service => serviceSection(service, state)).join('');
  return `<section class="pool-popover" aria-label="模型池详情">
    <div class="popover-heading">模型池
      <button class="icon-button" data-action="toggle-pool" aria-label="关闭模型池">${icon('close')}</button></div>
    <div class="popover-subtitle">所有用户会话共享 · 容量来自用户设置 · 请求为演示数据</div>
    <button class="pool-settings-link" data-action="settings-category" data-category="models">
      ${icon('settings')}配置模型 ${icon('chevron')}</button>
    <div class="segmented"><button class="${state.poolFilter === 'all' ? 'active' : ''}"
      data-action="pool-all">全部会话</button>
      <button class="${state.poolFilter === 'current' ? 'active' : ''}"
      data-action="pool-current">当前会话</button></div>
    ${pool.services.length ? scenarioNotice(state) + services
      : '<p class="popover-subtitle">没有已启用的模型服务。请在用户设置中添加或启用服务。</p>'}
    <div class="pool-footer"><span>上下文容量：未知 · 不估算占比</span>
      <select aria-label="模型池演示状态" id="pool-state">${scenarioOptions(state)}</select></div>
  </section>`;
}
