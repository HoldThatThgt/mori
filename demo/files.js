import { renderPanel } from './panels.js';
import { codingTask } from './task-state.js';

/** 可选中、可关联到聊天上下文的示例文件；内容只保存在当前页面。 */
export const demoFiles = {
  dispatch: {
    id: 'dispatch',
    path: 'packages/tools/dispatch.ts',
    name: 'dispatch.ts',
    version: 1,
    session: 'coding',
    language: 'typescript',
    stage: 'execution',
    activity: '修改',
    text: [
      "import type { Invocation, ToolRegistry } from './types';",
      "import { logger } from './logger';",
      '',
      '/**',
      ' * 核对调用保存的工具版本，再派发执行。',
      ' * @param call 待派发的工具调用。',
      ' * @param registry 当前可用工具注册表。',
      ' * @returns 执行结果或重新准备的要求。',
      ' */',
      'export async function dispatch(',
      '  call: Invocation,',
      '  registry: ToolRegistry,',
      ') {',
      '  const tool = registry.get(call.toolName);',
      '',
      '  // 定义版本变化只使关联的旧调用失效。',
      '  if (call.toolVersion !== tool.version) {',
      '    logger.error(',
      "      'Tool version changed before dispatch',",
      '      { name: call.toolName, expected: call.toolVersion, current: tool.version },',
      '    );',
      "    return { status: 'reprepare' } as const;",
      '  }',
      '',
      '  // 通过检查后，记录该版本工具产生的真实结果。',
      '  const result = await tool.execute(call.parameters);',
      "  return { status: 'completed', toolVersion: tool.version, result } as const;",
      '}',
    ].join('\n'),
  },
  guide: {
    id: 'guide',
    path: 'docs/tool-version-check.md',
    name: 'tool-version-check.md',
    version: 1,
    session: 'coding',
    language: 'markdown',
    stage: 'execution',
    activity: '修改',
    text: [
      '# 工具版本检查',
      '',
      '所属任务：为工具热更新补上版本检查',
      '',
      '## 目标',
      '',
      '旧请求的参数不能传给更新后的工具。',
      '每次请求保存实际使用的工具定义版本，',
      '在工具派发前再次核对相关版本。',
      '',
      '## 处理过程',
      '',
      '- 请求准备时保存工具名称和定义版本。',
      '- 派发前读取当前注册的工具。',
      '- 版本不一致时，记录原因并停止旧调用。',
      '- 按最新定义重新准备受影响的请求。',
      '- 旧调用的真实结果保留在原任务记录中。',
      '',
      '## 完成条件',
      '',
      '- 旧参数不会进入同名的新工具。',
      '- 无关工具更新不影响当前调用。',
      '- 后续请求使用最新工具定义。',
      '- 独立验收可以查看执行与检查证据。',
      '',
      '## 文件位置',
      '',
      '`packages/tools/dispatch.ts`：派发入口。',
      '`artifacts/tool-version-check.txt`：验证记录。',
    ].join('\n'),
  },
  evidence: {
    id: 'evidence',
    path: 'artifacts/tool-version-check.txt',
    name: 'tool-version-check.txt',
    version: 1,
    session: 'coding',
    language: 'text',
    stage: 'acceptance',
    activity: '验证记录',
    text: [
      'TOOL VERSION CHECK',
      'Demonstration record · Read only',
      '',
      'Task: tool-version-check',
      'Command: pnpm test tool-version',
      '',
      'PASS tool-version.test.ts',
      '',
      'PASS stops stale calls before dispatch',
      '  Request tool version: 12',
      '  Current tool version: 13',
      '  Tool execution count: 0',
      '  Result: reprepare',
      '',
      'PASS prepares calls with current definitions',
      '  Prepared tool version: 13',
      '  Executed tool version: 13',
      '  Result: completed',
      '',
      'PASS keeps unrelated tools running',
      '  Related tool version: unchanged',
      '  Result: completed',
      '',
      'Test files: 1 passed',
      'Tests: 3 passed',
      'Duration: 0.42 s',
      '',
      'No command was executed by this demo.',
    ].join('\n'),
  },
};

/**
 * 渲染任务阶段、关联文件、可选中正文和操作提示。
 * @param {{fileId: string, fileHighlight?: Object}} state 当前文件及可选的引用行范围。
 * @returns {string} 右侧内容区的 HTML。
 */
export function renderFileWorkspace(state) {
  if (state.session === 'research') return `<div class="file-empty-state">
    ${renderPanel({ ...state, panel: 'task' })}<p>当前研究任务尚未产生文件。</p></div>`;
  if (state.session !== 'coding') return `<div class="file-empty-state"><h3>当前会话暂无任务与文件</h3>
    <p>提出需求后，在这里查看任务进度和相关文件。演示不会执行真实任务。</p></div>`;
  const file = demoFiles[state.fileId];
  const lines = file.text.split('\n');
  const content = renderFileLines(file, state.fileHighlight);
  const attributes = `data-file-id="${file.id}" data-file-path="${escapeText(file.path)}" `
    + `data-version="${file.version}" data-session="${file.session}"`;
  return `<section class="file-workspace" data-language="${file.language}" aria-label="示例文件阅读器">
    ${renderTaskFiles(state, file)}${renderFileHeading(file, codingTask(state).evidence)}
    <div class="file-reader" tabindex="0" aria-label="${escapeText(file.name)} 文件内容">
      <pre class="file-code"><code class="file-content" ${attributes}>${content}</code></pre>
    </div>
    <div class="file-workspace-status"><span>${lines.length} 行 · UTF-8</span>
      <span>内容版本 ${file.version} · 只读</span></div>
    <footer class="file-workspace-hint">选中内容，向 Mori 提问或提出修改要求</footer>
  </section>`;
}

/**
 * 输出任务阶段和关联文件；任务始终跟随文件所属会话。
 * @param {Object} state 当前演示状态。
 * @param {Object} file 当前文件。
 * @returns {string} 默认可见的阶段列表和折叠详情。
 */
function renderTaskFiles(state, file) {
  const taskState = { ...state, panel: 'task', session: file.session };
  const stages = taskStages(state);
  return `<div class="task-file-overview">
    <header class="task-file-heading"><span class="file-demo-label">演示任务 · 目标版本 ${state.revision}</span>
      <h3>${escapeText(state.titles[file.session])}</h3></header>
    <div class="task-file-stages" aria-label="任务阶段与文件">
      ${stages.map(stage => renderStage(stage, file.id)).join('')}</div>
    <details class="task-workspace-details"><summary>任务详情与完成条件</summary>
      ${renderPanel(taskState)}</details>
  </div>`;
}

/**
 * 按真实演示进度标明执行完成和独立验收的区别。
 * @param {Object} state 当前演示状态。
 * @returns {Object[]} 任务阶段及文件归属。
 */
function taskStages(state) {
  const task = codingTask(state);
  return [
    { id: 'goal', name: '目标整理', status: '已确认', style: 'done', note: '旧参数不能进入更新后的工具' },
    { id: 'execution', name: '执行', status: '已完成', style: 'done' },
    { id: 'acceptance', name: '独立验收', status: task.evidence, style: task.style },
  ];
}

/**
 * 在阶段下直接列出该阶段关联的文件。
 * @param {Object} stage 阶段名称及状态。
 * @param {string} selected 当前文件标识。
 * @returns {string} 阶段与文件按钮组。
 */
function renderStage(stage, selected) {
  const files = Object.values(demoFiles).filter(file => file.stage === stage.id);
  const buttons = files.map(file => fileButton(file, selected)).join('');
  return `<section class="task-file-stage ${stage.style}" aria-label="${stage.name}">
    <span class="task-stage-dot" aria-hidden="true"></span>
    <div class="task-stage-content"><div class="task-stage-heading"><strong>${stage.name}</strong>
      <span>${stage.status}</span></div>${stage.note ? `<p class="task-stage-note">${stage.note}</p>` : ''}
      ${files.length ? `<div class="task-stage-files">${buttons}</div>` : ''}
    </div></section>`;
}

/**
 * 创建由应用处理切换的阶段文件按钮。
 * @param {Object} file 文件内容及元数据。
 * @param {string} selected 当前文件标识。
 * @returns {string} 可通过键盘聚焦的文件按钮 HTML。
 */
function fileButton(file, selected) {
  const marks = { typescript: 'TS', markdown: 'MD', text: 'TXT' };
  return `<button type="button" class="task-stage-file ${file.id === selected ? 'active' : ''}"
    data-action="open-file" data-file-id="${file.id}" aria-pressed="${file.id === selected}"
    title="${escapeText(file.path)}"><span class="file-type-mark ${file.language}">${marks[file.language]}</span>
    <span class="file-tab-name">${escapeText(file.name)}</span>
    <span class="file-activity">${file.activity}</span></button>`;
}

/**
 * 在正文上方标明文件位置和发生改动的阶段。
 * @param {Object} file 当前文件。
 * @param {string} recordStatus 当前验收记录状态。
 * @returns {string} 文件位置与阶段说明。
 */
function renderFileHeading(file, recordStatus) {
  const folder = file.path.slice(0, file.path.lastIndexOf('/'));
  const stage = file.stage === 'execution' ? '执行阶段修改' : `独立验收记录 · ${recordStatus}`;
  return `<div class="file-workspace-toolbar">
    <div class="file-heading-row"><strong>${escapeText(file.name)}</strong>
      <span class="file-stage-label">${stage}</span></div>
    <div class="file-breadcrumb" title="${escapeText(file.path)}">
      <span class="file-workspace-root">mori</span><span class="file-path-divider">/</span>
      <span class="file-folder-path">${escapeText(folder.replaceAll('/', ' / '))}</span>
    </div></div>`;
}

/**
 * 保留文件的精确文本和行号节点，供选区引用读取。
 * @param {Object} file 文件文本。
 * @param {Object} highlight 可选的引用行范围。
 * @returns {string} 不含额外空白的文件正文。
 */
function renderFileLines(file, highlight) {
  return file.text.split('\n').map((line, index) => {
    const referenced = highlight?.fileId === file.id
      && index + 1 >= highlight.startLine && index + 1 <= highlight.endLine;
    const className = referenced ? 'file-line is-referenced' : 'file-line';
    return `<span class="${className}" data-line="${index + 1}">${escapeText(line)}</span>`;
  }).join('\n');
}

/**
 * 转义文件中的原始字符，不改变其浏览器文字内容。
 * @param {string} text 原始文件文字。
 * @returns {string} 安全的 HTML 文字。
 */
function escapeText(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
