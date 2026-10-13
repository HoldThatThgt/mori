import { icon } from './icons.js';
import { escapeHtml } from './feedback.js';

/** @brief 生成绑定用户会话的模型请求行。 */
function requestRow(role, session, status, state) {
  const title = session === 'maintenance' ? '整理沟通与纠正' : state.titles[session];
  const projects = { coding: 'mori', research: '资料研究', maintenance: '工作回顾' };
  const action = session === 'maintenance' ? 'show-maintenance' : `session-${session}`;
  return `<button class="request-row" data-action="${action}">
    <span class="request-role">${role.slice(0, 1)}</span><span>
    <span class="request-title">${role} · ${escapeHtml(title)}</span>
    <div class="request-meta">${projects[session]} · 独立上下文</div></span>
    <span class="request-status ${status === '排队中' ? 'queued' : ''}">${status}</span></button>`;
}

/** @brief 依据演示状态返回模型池的文字和颜色。 */
export function poolStatus(state) {
  const states = {
    normal: { label: '模型池 · 正常', dot: '', detail: '正常运行 · 1 / 2' },
    full: { label: '模型池 · 推理池已满', dot: 'full', detail: '槽位已满 · 2 / 2' },
    warning: { label: '模型池 · 限流', dot: 'warning', detail: '服务限流 · 429' },
    error: { label: '模型池 · 已停止', dot: 'error', detail: '认证失败 · 已停止' },
    idle: { label: '模型池 · 空闲', dot: 'idle', detail: '可用槽位 · 2 / 2' },
  };
  return states[state.poolState];
}

/** @brief 渲染池内真实区分的请求与错误状态演示。 */
function poolRequests(state) {
  const currentOnly = state.poolFilter === 'current';
  if (state.poolState === 'idle') return '<p class="popover-subtitle">当前没有请求运行，可以接收新请求。</p>';
  if (state.poolState === 'error') return `<div class="pool-error">推理模型返回 401，受影响请求已停止。
    <br>请更新认证后明确恢复；不会自动切换模型。</div>`;
  if (state.poolState === 'warning') return `<div class="pool-error">已收到服务端 429 限流响应。
    <br>验收请求等待重试，资料研究保留当前进度。</div>`;
  const full = state.poolState === 'full';
  const codingActive = !['completed', 'paused'].includes(state.phase);
  const requests = [['参考检索', 'research', '等待响应']];
  if (codingActive) requests.unshift([state.phase === 'review' ? '验收' : '执行', 'coding', full ? '输出中' : '排队中']);
  if (full && codingActive && state.phase !== 'review') requests.push(['验收', 'coding', '排队中']);
  if (full && !codingActive) requests.push(['学习', 'maintenance', '输出中']);
  const visible = requests.filter(([, session]) => !currentOnly || session === state.session);
  return visible.length ? visible.map(args => requestRow(...args, state)).join('')
    : '<p class="popover-subtitle">当前会话暂无请求。</p>';
}

/** @brief 渲染紧凑模型池详情，不将演示容量表示成实际配置。 */
export function renderPool(state) {
  const status = poolStatus(state);
  return `<section class="pool-popover" aria-label="模型池详情">
    <div class="popover-heading">模型池
      <button class="icon-button" data-action="toggle-pool" aria-label="关闭模型池">${icon('close')}</button></div>
    <div class="popover-subtitle">所有用户会话共享 · 模型与容量为演示数据</div>
    <button class="pool-settings-link" data-action="settings-category" data-category="models">
      ${icon('settings')}配置模型 ${icon('chevron')}</button>
    <div class="segmented"><button class="${state.poolFilter === 'all' ? 'active' : ''}"
      data-action="pool-all">全部会话</button>
      <button class="${state.poolFilter === 'current' ? 'active' : ''}"
      data-action="pool-current">当前会话</button></div>
    <div class="pool-section"><div class="pool-heading"><span class="dot idle"></span>快速模型
      <span>空闲 · 2 个可用槽位</span></div>
      <p class="popover-subtitle">对话与目标整理 · 暂无请求</p></div>
    <div class="pool-section"><div class="pool-heading"><span class="dot ${status.dot}"></span>推理模型
      <span>${status.detail}</span></div>${poolRequests(state)}</div>
    <div class="pool-footer"><span>上下文容量：未知 · 不估算占比</span>
      <select aria-label="模型池演示状态" id="pool-state">
        ${[['normal','正常运行'],['full','槽位已满'],['warning','服务限流'],['error','错误停止'],['idle','空闲']]
          .map(([value,label]) => `<option value="${value}" ${value === state.poolState ? 'selected' : ''}>
            演示：${label}</option>`).join('')}
      </select></div>
  </section>`;
}
