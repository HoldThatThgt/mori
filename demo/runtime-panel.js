import { icon } from './icons.js';
import { getModelPool } from './pool.js';
import { codingTask } from './task-state.js';

/** @brief 根据任务阶段提供独立验收实例的演示记录。 */
function acceptanceRecord(state) {
  if (state.phase === 'review') {
    const task = codingTask(state);
    if (task.style !== 'current') {
      return { status: task.status, style: 'pending', text: `${task.progress}，尚未完成独立验收。` };
    }
  }
  return {
    acceptance: { status: '未启动', style: 'pending', text: '审查 main agent 尚未委派，尚无实例或会话。' },
    review: { status: '验收中', style: 'active', text: '独立读取文件和示例测试记录，核对当前目标的完成条件。' },
    completed: { status: '已完成', style: 'success', text: '已独立核对证据并提交验收结论，程序已完成示例任务。' },
  }[state.phase];
}

/** @brief 生成当前编码用户会话的两层 Agent 记录。 */
function agentRecords(state) {
  const acceptance = acceptanceRecord(state);
  return [
    { id: 'coding-main', name: '默认入口', type: 'main agent', status: '已就绪', style: 'success',
      purpose: '整理目标、接收执行结果，并与平级审查 main agent 交换验收证据。',
      summary: '执行 subagent 已交付文件与检查记录；独立验收由平级审查 main agent 安排。',
      children: ['coding-execution'] },
    { id: 'coding-execution', name: '执行', type: 'subagent', status: '已完成', style: 'success',
      purpose: '只处理工具派发版本检查，所属 main agent 为默认入口。',
      summary: '已读取派发入口、修改示例文件并记录测试结果，未自行宣告整个任务完成。', children: [] },
    { id: 'coding-review', name: '审查', type: 'main agent', status: '已就绪', style: 'success',
      purpose: '与默认入口平级；负责独立验收，拥有自己的 subagent。',
      summary: '只使用双方 main agent 交换的证据，不直接读取另一族 subagent 的会话。',
      children: ['coding-acceptance'] },
    { id: 'coding-acceptance', name: '独立验收', type: 'subagent', status: acceptance.status,
      style: acceptance.style, purpose: '所属 main agent 为审查；不参与执行者的文件修改。',
      summary: acceptance.text, children: [] },
  ];
}

/** @brief 渲染可选择的 Agent 条目，未启动定义明确保留占位说明。 */
function agentButton(agent, selected) {
  const pending = agent.status === '未启动';
  return `<button type="button" class="runtime-agent ${selected === agent.id ? 'selected' : ''}"
    data-action="runtime-select-agent" data-agent="${agent.id}" aria-pressed="${selected === agent.id}">
    <span class="runtime-agent-symbol">${icon(agent.type === 'main agent' ? 'grid' : 'branch')}</span>
    <span class="runtime-agent-name"><strong>${agent.name}</strong><small>${agent.type}
      ${pending ? ' · 定义待委派' : ''}</small></span>
    <span class="panel-badge ${agent.style}">${agent.status}</span></button>`;
}

/** @brief 在同一级展示 main agent，并且只缩进各自的直接 subagent。 */
function renderAgents(state) {
  const agents = agentRecords(state);
  const selected = agents.find(agent => agent.id === state.runtimeAgent);
  const families = agents.filter(agent => agent.type === 'main agent').map(main => {
    const children = main.children.map(id => agents.find(agent => agent.id === id));
    return `<li class="runtime-family">${agentButton(main, state.runtimeAgent)}
      <ul class="runtime-agent-children">${children.map(child => `<li>
        ${agentButton(child, state.runtimeAgent)}</li>`).join('')}</ul></li>`;
  }).join('');
  return `<section class="runtime-section" aria-label="当前用户会话的 Agent">
    <div class="runtime-section-heading"><h4>Agent 与独立会话</h4><span>同一用户会话</span></div>
    <ul class="runtime-agent-tree">${families}</ul>
    <div class="runtime-agent-summary" aria-live="polite"><strong>${selected.name} ·
      ${selected.status === '未启动' ? '尚无独立会话' : '独立会话摘要'}</strong>
      <p>${selected.purpose}</p><p>${selected.summary}</p></div>
    <p class="runtime-note">main agent 相互平级；每个 subagent 只属于其上方的 main agent，不能继续创建 subagent。</p>
  </section>`;
}

/** @brief 展示一次示例工具调用的参数、输出和关联文件。 */
function renderToolCall(call) {
  return `<li><details class="runtime-tool-call"><summary><span class="runtime-call-icon">${icon('check')}</span>
    <span><strong>${call.name}</strong><small>${call.status}</small></span></summary>
    <div class="runtime-call-body"><span class="runtime-label">参数</span><pre>${escapeText(call.parameters)}</pre>
      <span class="runtime-label">示例输出</span><pre>${escapeText(call.result)}</pre>
      <button type="button" class="runtime-file-link" data-action="open-file" data-file-id="${call.file}">
        ${icon('file')}<span>${call.fileName}</span></button></div></details></li>`;
}

/** @brief 将已发生的工具调用按读取、修改、检查顺序展示。 */
function renderTools() {
  const calls = [
    { name: 'read_file', status: '已读取派发入口', parameters: 'path: packages/tools/dispatch.ts',
      result: 'Read completed.\nObserved: tool version was not checked before dispatch.',
      file: 'dispatch', fileName: 'dispatch.ts' },
    { name: 'apply_patch', status: '已修改示例文件',
      parameters: 'files: packages/tools/dispatch.ts, docs/tool-version-check.md',
      result: 'Patch applied.\nChanged: reject stale calls before dispatch.\nUpdated: completion criteria.',
      file: 'guide', fileName: 'tool-version-check.md' },
    { name: 'run_command', status: '示例测试通过', parameters: 'command: pnpm test tool-version',
      result: 'PASS tool-version.test.ts\nTests: 3 passed\nNo command was executed by this demo.',
      file: 'evidence', fileName: 'tool-version-check.txt' },
  ];
  return `<section class="runtime-section"><details class="runtime-group">
    <summary><span>工具调用树</span><span class="runtime-group-meta">执行 subagent · 已完成</span></summary>
    <p class="runtime-note">这里是本次示例执行记录；工具页用于管理能力与连接。</p>
    <ol class="runtime-tool-tree">${calls.map(renderToolCall).join('')}</ol></details></section>`;
}

/** @brief 展示当前请求或尚未发送的准备状态，不把准备工作计为请求。 */
function renderRequest(request) {
  const pending = request.state === 'pending';
  const kind = pending ? '准备状态 · 尚未发送' : '模型请求';
  return `<details class="runtime-request"><summary><span>${escapeText(request.role)}</span>
    <span class="panel-badge ${request.state === 'active' ? 'active' : ''}">
      ${escapeText(request.status)}</span></summary>
    <div class="runtime-request-body"><p><span>${kind}</span> · ${escapeText(request.model)}</p>
      <p>${pending ? '不占用模型槽位。' : `请求标识：${escapeText(request.id)}`}</p>
      ${request.waitingReason ? `<p>${escapeText(request.waitingReason)}</p>` : ''}</div></details>`;
}

/** @brief 从模型池唯一数据来源读取当前用户会话的请求记录。 */
function renderRequests(state) {
  const requests = getModelPool(state).requests.filter(request => request.session === state.session);
  const sent = requests.filter(request => request.state !== 'pending').length;
  return `<section class="runtime-section"><details class="runtime-group" open>
    <summary><span>模型请求轨迹</span><span class="runtime-group-meta">${sent} 个请求</span></summary>
    ${requests.length ? requests.map(renderRequest).join('')
      : '<p class="runtime-note">当前会话没有待处理的模型请求。</p>'}
    <p class="runtime-note">与模型池共用演示状态，未连接真实模型服务。</p></details></section>`;
}

/** @brief 输出仅由应用执行状态切换的场景操作按钮。 */
function scenarioAction(resolution, label) {
  return `<button type="button" class="runtime-action" data-action="runtime-resolve"
    data-resolution="${resolution}">${label}</button>`;
}

/** @brief 渲染等待登录场景，登录检查只改变演示状态。 */
function loginScenario(resolution) {
  if (resolution === 'verified') return `<strong>登录检查已完成</strong>
    <p>示例任务可以继续；没有打开网站或读取真实登录信息。</p>`;
  return `<strong>等待登录</strong><p>示例内网页面需要登录，相关操作尚未派发。</p>
    ${scenarioAction('login', '演示登录完成并继续')}`;
}

/** @brief 先核对未知结果，只有确认未执行时才显示再次执行入口。 */
function unknownScenario(resolution) {
  if (resolution === 'verified') return `<strong>结果已核对 · 示例操作已完成</strong>
    <p>先确认原操作未执行，再由用户触发了一次示例操作。</p><pre>Result: completed\nExecution count: 1</pre>`;
  if (resolution === 'not-executed') return `<strong>已确认原操作未执行</strong>
    <p>核对示例产物后确认没有产生副作用，现在可以明确选择再次执行。</p>
    <pre>Result: not_executed\nExecution count: 0</pre>${scenarioAction('retry', '再次执行示例操作')}`;
  return `<strong>结果未知</strong><p>示例写操作已派发，但响应中断。完成前先核对产物，不能直接重放。</p>
    <pre>Result: unknown\nAwaiting verification</pre>${scenarioAction('check', '核对操作结果')}`;
}

/** @brief 渲染休眠后错过维护的显式恢复或跳过选择。 */
function sleepScenario(resolution) {
  if (resolution === 'resumed') return `<strong>已恢复本次工作回顾</strong>
    <p>根据本次选择恢复示例维护流程，真实定时任务未启动。</p>`;
  if (resolution === 'skipped') return `<strong>已跳过本次工作回顾</strong>
    <p>保留错过的记录，本次不补跑；后续仍按原计划处理。</p>`;
  return `<strong>休眠恢复 · 待处理</strong><p>休眠期间错过一次工作回顾，尚未补跑。
    当前任务已核对执行记录并恢复到待验收，不重复执行已完成步骤。
    工作回顾独立处理：恢复本次维护，或保留记录并跳过，不阻塞当前任务。</p><div class="runtime-actions">
    ${scenarioAction('resume', '恢复本次工作回顾')}${scenarioAction('skip', '跳过本次')}</div>`;
}

/** @brief 提供显式场景切换与只影响演示的处理动作。 */
function renderScenario(state) {
  const options = [['none', '正常任务'], ['login', '等待登录'], ['unknown', '结果未知'], ['sleep', '休眠恢复']];
  const renderers = { login: loginScenario, unknown: unknownScenario, sleep: sleepScenario };
  const content = state.runtimeScenario === 'none' ? '<p>选择场景，查看中断后的状态和处理过程。</p>'
    : renderers[state.runtimeScenario](state.runtimeResolution);
  return `<section class="runtime-section runtime-scenario"><label for="runtime-scenario">演示恢复场景</label>
    <select id="runtime-scenario">${options.map(([value, label]) => `<option value="${value}"
      ${state.runtimeScenario === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
    <div class="runtime-scenario-content" aria-live="polite">${content}</div>
    <p class="runtime-note">所有动作只切换页面演示，不执行登录、网络写入或维护任务。</p></section>`;
}

/**
 * @brief 渲染当前用户会话的 Agent、工具调用、模型请求与恢复场景。
 * @param {Object} state 当前用户会话及运行记录的演示状态。
 * @returns {string} 运行记录面板的 HTML。
 */
export function renderRuntimePanel(state) {
  if (state.session !== 'coding' && state.session !== 'research') {
    return `<div class="detail-panel-body runtime-panel"><div class="panel-intro">
      <span class="panel-eyebrow">当前用户会话</span><h3>暂无运行记录</h3>
      <p>新会话尚未启动 Agent 或产生工具调用、模型请求。</p></div></div>`;
  }
  const intro = `<div class="panel-intro"><span class="panel-eyebrow">演示数据 · 当前用户会话</span>
    <h3>运行记录</h3><p>查看独立会话、工具调用与请求状态。记录均为预置示例。</p></div>`;
  if (state.session === 'research') return `<div class="detail-panel-body runtime-panel">${intro}
    <div class="runtime-agent-summary"><strong>资料研究 · 独立用户会话</strong>
      <p>此会话与编码任务独立，不属于编码 Agent 的 subagent。暂无预置工具调用。</p></div>
    ${renderRequests(state)}</div>`;
  return `<div class="detail-panel-body runtime-panel">${intro}${renderAgents(state)}${renderTools()}
    ${renderRequests(state)}${renderScenario(state)}</div>`;
}

/** @brief 将配置名称和示例原文转义为安全的 HTML 文本。 */
function escapeText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
