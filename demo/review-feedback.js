import { icon } from './icons.js';
import { escapeHtml } from './feedback.js';

export const sampleFeedback = [
  { id: 'example-result', expected: '先告诉我改好了什么，再展开解释。',
    quote: '我会先检查工具版本，再核对调用参数和连接状态。',
    source: '示例回复', session: 'coding', version: 1, example: true },
  { id: 'example-context', expected: '复杂方案还是要把依据说清楚，别为了简短省掉原因。',
    quote: '方案可以采用，具体分析就不展开了。',
    source: '示例沟通', session: 'research', version: 1, example: true },
];

/** @brief 根据页面内的记录标识读取原始反馈，示例不混入用户反馈。 */
export function reviewFeedback(state, id) {
  return id.startsWith('current-') ? state.feedbacks[Number(id.slice(8))]
    : sampleFeedback.find(record => record.id === id);
}

/** @brief 在对应回顾下面展示来源反馈，尚未回顾的记录单独保留。 */
export function renderFeedbackRow(state, record, id) {
  const selected = state.reviewSelection.kind === 'feedback' && state.reviewSelection.id === id;
  return `<button class="review-feedback-row ${selected ? 'selected' : ''}" data-action="review-select"
    data-kind="feedback" data-id="${id}" data-review-item="feedback-${id}" aria-pressed="${selected}">
    <span class="review-row-mark">${icon('feedback')}</span><span class="review-row-copy">
      <strong>${escapeHtml(record.expected)}</strong>
      <small>${record.example ? '示例原话' : '待模型判断'} ·
        ${escapeHtml(record.filePath || state.titles[record.session])}</small></span>${icon('chevron')}</button>`;
}

/** @brief 展示原话、原文与关联回顾，未处理记录不伪装成已有结论。 */
export function renderFeedbackDetail(state, record) {
  return `<span class="detail-eyebrow">${record.example ? '反馈与沟通 · 示例' : '本次反馈'}</span>
    <h2>希望得到的结果</h2><p class="feedback-expected">${escapeHtml(record.expected)}</p>
    <span class="status-tag neutral">${record.example ? '已纳入示例回顾' : '已记录 · 待模型判断'}</span>
    <section class="detail-section"><h3>针对的原文</h3><blockquote>${escapeHtml(record.quote)}</blockquote></section>
    <dl class="detail-facts"><div><dt>来源会话</dt><dd>${escapeHtml(state.titles[record.session])}</dd></div>
      <div><dt>内容来源</dt><dd>${escapeHtml(feedbackSourceLabel(record))}</dd></div>
      <div><dt>内容版本</dt><dd>${record.version}</dd></div></dl>
    ${record.example ? '' : `<button class="button page-full-button" ${feedbackSource(record)}>
      ${icon('link')}返回来源</button>`}
    ${record.example ? feedbackReviewLinks() : `<section class="detail-section"><h3>处理进展</h3>
      <p>尚未纳入回顾，也未形成候选。Mori 需要结合原文与上下文判断具体分类和影响范围。</p>
      <p>当前任务的纠正及时处理，不等待定时回顾。</p></section>`}
    <p class="page-demo-note">${record.example ? '这是预置示例，没有对应的真实会话原文。' : ''}
      当前 demo 未连接模型，记录反馈不会自动修改任务或发布长期偏好。</p>`;
}

/** @brief 从已回顾的原话追踪对应回顾与候选。 */
function feedbackReviewLinks() {
  return `<section class="detail-section"><h3>这条反馈用在哪里</h3>
    <button class="review-related-link" data-action="review-select" data-kind="run" data-id="example">
      ${icon('clock')}<span><strong>整理沟通中的纠正</strong><small>所属回顾 · 示例</small></span>${icon('chevron')}
    </button><button class="review-related-link" data-action="review-select" data-kind="candidate" data-id="example">
      ${icon('memory')}<span><strong>先说结果，再解释原因</strong><small>形成的候选 · 未发布</small></span>
      ${icon('chevron')}</button></section>`;
}

/** @brief 使用可读名称展示反馈来源，不向用户暴露消息标识。 */
function feedbackSourceLabel(record) {
  if (record.filePath) return record.filePath;
  if (record.source === 'artifact-dispatch') return 'packages/tools/dispatch.ts';
  return record.example ? record.source : '会话回复';
}

/** @brief 从真实反馈返回原文件选区或原消息。 */
function feedbackSource(record) {
  if (record.fileId || record.source === 'artifact-dispatch') {
    const selection = record.startLine
      ? `data-start-line="${record.startLine}" data-end-line="${record.endLine}"` : '';
    return `data-action="feedback-source" data-file-id="${record.fileId || 'dispatch'}"
      data-session="${record.session}" ${selection}`;
  }
  return `data-action="open-chat-reference" data-session="${record.session}"
    data-source="${escapeHtml(record.source)}" data-version="${record.version}"`;
}
