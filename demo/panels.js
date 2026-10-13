/** 输出面板中重复使用的小图标。 */
function icon(name) {
  const paths = {
    check: '<path d="m5 10 3 3 7-7"/>',
    file: '<path d="M12 2H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6z"/>'
      + '<path d="M12 2v5h4M7 11h6M7 14h4"/>',
    clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/>',
    shield: '<path d="m10 2 6 3v5c0 4-6 8-6 8s-6-4-6-8V5z"/><path d="m7 10 2 2 4-4"/>',
    refresh: '<path d="M16 8a6 6 0 0 0-10-4L3 7M3 3v4h4M4 12a6 6 0 0 0 10 4l3-3m0 4v-4h-4"/>',
    arrow: '<path d="M5 10h10m-4-4 4 4-4 4"/>',
    terminal: '<path d="m4 5 4 4-4 4m7 1h5"/>',
    folder: '<path d="M2 5h6l2 2h8v9H2z"/>',
  };
  return `<svg class="panel-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor"
    stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

/** 为每个面板提供一致的内容容器。 */
function panel(content) {
  return `<div class="detail-panel-body">${content}</div>`;
}

/** 显示说明区及演示标记。 */
function intro(title, description) {
  return `<div class="panel-intro"><span class="panel-eyebrow">演示数据</span>
    <h3>${title}</h3><p>${description}</p></div>`;
}

/** 展示终端示例，不执行命令。 */
function renderTerminal() {
  return panel(`${intro('检查执行记录', '一段已准备的终端输出，用来展示验证过程。')}
    <div class="terminal-card"><div class="terminal-card-bar">${icon('terminal')}
      <span>PowerShell</span><span class="terminal-readonly">只读演示</span></div>
      <pre><span class="terminal-prompt">PS D:\\code\\mori&gt;</span> pnpm test tool-version

<span class="terminal-pass">PASS</span> tool-version.test.ts
  <span class="terminal-pass">✓</span> stops stale calls before dispatch
  <span class="terminal-pass">✓</span> prepares calls with current definitions
  <span class="terminal-pass">✓</span> keeps unrelated tools running

<span class="terminal-muted">Test files</span>  1 passed
<span class="terminal-muted">Tests</span>       3 passed
<span class="terminal-muted">Duration</span>    0.42s

<span class="terminal-prompt">PS D:\\code\\mori&gt;</span> <span class="terminal-cursor">▏</span></pre></div>
    <div class="panel-note">${icon('shield')}<p>检查结果会作为验收证据；
      执行者给出“已完成”本身不能使任务完成。</p></div>
    <p class="panel-footnote">命令和输出均为演示内容，没有在你的机器上执行。</p>`);
}

/** 输出一项检查结果及其语义说明。 */
function checkItem(title, description, passed) {
  return `<div class="panel-check ${passed ? 'passed' : 'pending'}">
    <span class="panel-check-icon">${icon(passed ? 'check' : 'clock')}</span>
    <div><strong>${title}</strong><p>${description}</p></div></div>`;
}

/** 展示验收条件和监督依据，区分执行结束与完成。 */
function renderTask(state) {
  if (state.session === 'research') return renderResearchTask(state);
  const statuses = { running: '待验收', review: '待验收', completed: '已完成', paused: '已暂停' };
  const completed = state.phase === 'completed';
  const current = {
    running: '准备独立验收 · 示例代码已修改，检查已通过',
    review: '独立验收中 · 正在核对完成条件、文件内容与检查记录',
    completed: '完成条件均有证据，独立验收已通过',
    paused: '停止发起新操作，等待继续',
  };
  return panel(`${intro('为工具热更新补上版本检查', '目标随任务保存，执行者可以更换上下文继续工作。')}
    <div class="task-status-row"><span class="panel-badge ${completed ? 'success' : 'active'}">
      ${statuses[state.phase]}</span><span class="panel-secondary">任务版本 ${state.revision}</span></div>
    <p class="task-current">${current[state.phase]}</p>
    <div class="panel-section"><h4>完成条件</h4>
      ${checkItem('旧调用不会误用新定义', '派发前核对请求记录与当前工具版本。', true)}
      ${checkItem('后续请求使用最新定义', '示例检查通过，只重新准备受影响的调用。', true)}
      ${checkItem('独立验收确认结果', completed ? '验收会话已核对文件内容和检查记录。' : '由独立上下文核对证据。', completed)}
    </div><div class="panel-section"><h4>监督记录</h4>
      <div class="supervision-card"><span class="panel-badge warning">已纠正 · 在写入前介入</span>
        <strong>只在发送前检查，仍有过期窗口</strong><p>原计划只在发送前检查工具定义，排队期间定义仍可能过期。
        监督在尚未写入时要求派发前再检，执行者已据此调整示例实现。</p>
        <div class="panel-evidence">${icon('shield')}<span>依据：任务约束、执行计划与工具派发边界</span></div></div>
    </div><div class="panel-section"><h4>执行约束</h4><ul class="panel-constraints">
      <li>仅修改工具派发前的检查。</li><li>不重启当前用户会话。</li><li>无关工具更新不影响正在进行的工作。</li>
    </ul></div><div class="panel-section"><h4>反馈与修订</h4>
      <p class="panel-plain-text">${state.feedbacks.length ? `已记录 ${state.feedbacks.length} 条反馈，待模型判断。`
        : '暂无反馈。选中聊天中的文字，可以直接纠正。'}</p>
      <p class="panel-footnote">模型判断后由程序核对是否更新任务；长期偏好需要另行形成候选。</p></div>`);
}

/** 展示资料研究任务的独立进度与验收条件。 */
function renderResearchTask(state) {
  return panel(`${intro('MCP 连接更新方案对比', '查证成熟方案的连接交接方式，并保留可核对的来源。')}
    <div class="task-status-row"><span class="panel-badge active">等待</span>
      <span class="panel-secondary">任务版本 ${state.revision}</span></div>
    <p class="task-current">参考检索 · 等待响应</p>
    <div class="panel-section"><h4>当前片段</h4><p class="panel-plain-text">
      参考检索使用独立上下文，正在等待模型返回连接更新方案与来源。
      请求仍在约定等待时间内，不标记为网络异常。</p></div>
    <div class="panel-section"><h4>完成条件</h4>
      ${checkItem('整理可核对的参考方案', '保留官方文档或源码来源，区分已验证能力与假设。', false)}
      ${checkItem('比较连接交接边界', '说明新连接初始化、旧调用收尾与失败后的状态。', false)}
      ${checkItem('独立验收确认依据', '核对结论是否由引用资料支持。', false)}</div>
    <div class="panel-section"><h4>研究范围</h4><ul class="panel-constraints">
      <li>对比工具定义更新与认证更新的生效边界。</li>
      <li>仅检索参考资料，不修改项目配置。</li>
      <li>不将资料中的建议视为已经采纳的设计。</li></ul></div>
    <div class="panel-note">${icon('clock')}<p>切换到其他用户会话后，此请求仍由模型池继续调度。</p></div>`);
}

/** 根据当前面板及演示状态生成右侧详情内容。 */
export function renderPanel(state) {
  if (state.panel === 'terminal' && state.session !== 'coding') {
    return panel(intro('当前会话暂无终端记录', '这里仅展示当前会话的执行记录。'));
  }
  const panels = {
    terminal: renderTerminal,
    task: renderTask,
  };
  return panels[state.panel](state);
}
