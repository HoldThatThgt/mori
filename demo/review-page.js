import { icon } from './icons.js';
import { sampleFeedback, reviewFeedback, renderFeedbackRow, renderFeedbackDetail } from './review-feedback.js';

/** @brief 将尚未回顾的真实反馈直接放在同一页面，保留待模型判断状态。 */
function pendingFeedback(state) {
  return `<section class="review-pending"><div class="page-section-heading"><h2>尚未回顾</h2>
    <span>本次反馈 · ${state.feedbacks.length} 条</span></div>
    ${state.feedbacks.length ? `<div class="review-feedback-list">${state.feedbacks.map((record, index) =>
      renderFeedbackRow(state, record, `current-${index}`)).join('')}</div>` : `<div class="review-empty">
      ${icon('feedback')}<p>在会话或文件中选中文字，点击“反馈”。<br>记录会出现在这里，无需选择分类。</p>
      <button class="text-link" data-action="return-chat">返回会话 ${icon('chevron')}</button></div>`}</section>`;
}

/** @brief 回顾记录直接包含来源反馈和候选，避免将关联信息拆到不同页面。 */
function reviewHistory(state) {
  const runSelected = state.reviewSelection.kind === 'run';
  const candidateSelected = state.reviewSelection.kind === 'candidate';
  return `<section class="review-history"><div class="page-section-heading"><h2>回顾记录</h2>
    <span>以下为示例</span></div><article class="review-history-card">
    <button class="review-run ${runSelected ? 'selected' : ''}" data-action="review-select" data-kind="run"
      data-id="example" data-review-item="run-example" aria-pressed="${runSelected}">
      <span class="list-icon">${icon('clock')}</span><span class="list-copy"><strong>整理沟通中的纠正</strong>
        <span>两条原话 → 一个未发布候选</span></span>${icon('chevron')}</button>
    <div class="review-history-content"><div class="review-step-heading">${icon('feedback')}使用的反馈与沟通</div>
      <div class="review-feedback-list">${sampleFeedback.map(record =>
        renderFeedbackRow(state, record, record.id)).join('')}</div>
      <div class="review-step-heading">${icon('memory')}形成的候选</div>
      <button class="candidate-card ${candidateSelected ? 'selected' : ''}" data-action="review-select"
        data-kind="candidate" data-id="example" data-review-item="candidate-example"
        aria-pressed="${candidateSelected}"><span class="candidate-card-top">
          <span class="status-tag neutral">表达偏好 · 未发布</span>${icon('chevron')}</span>
        <strong>先说结果，再解释原因</strong><p>编码任务的进展说明先给结论，复杂方案仍保留必要依据。</p>
        <small>${icon('link')}依据来自上面的两条原话</small></button></div></article></section>`;
}

/** @brief 统一展示日常反馈、回顾记录与后续候选。 */
function reviewMain(state) {
  return `<div class="page-heading"><span class="page-eyebrow">反馈、沟通与后续结果</span>
    <h1>工作回顾</h1><p>从原话到回顾结果，在这里一起查看。</p></div>
    <div class="review-schedule review-schedule-compact">${icon('clock')}<span>定时回顾尚未设置</span>
      <small>当前展示回顾示例</small></div>${pendingFeedback(state)}${reviewHistory(state)}
    <div class="page-inline-note">${icon('clock')}<p>当前任务的纠正及时处理；需要长期吸收的反馈与沟通，
      在回顾中整理为候选。记录成功不代表已经采纳。</p></div>`;
}

/** @brief 在候选详情中直接列出可点开的原话，并保留反证与适用范围。 */
function candidateDetail(state) {
  return `<span class="detail-eyebrow">回顾形成的候选 · 示例</span><h2>先说结果，再解释原因</h2>
    <span class="status-tag neutral">未发布</span><p class="detail-lead">先告诉用户当前结论和下一步，
      然后给出理解结果所需的依据。</p>
    <section class="detail-section"><h3>依据哪些原话</h3><div class="review-feedback-list">
      ${sampleFeedback.map(record => renderFeedbackRow(state, record, record.id)).join('')}</div></section>
    <section class="detail-section"><h3>适用范围</h3><p>编码任务的进展说明。复杂方案评审仍需要充分解释。</p></section>
    <section class="detail-section"><h3>反证与待定项</h3><ul class="detail-checks">
      <li>${icon('check')}关于复杂方案的原话要求保留依据，不能将简洁理解为省略解释。</li>
      <li>${icon('check')}一次纠正不扩大为全局偏好。</li>
      <li>${icon('clock')}采纳标准尚未确定，保持未发布。</li></ul></section>
    <button class="button page-full-button" data-action="review-select" data-kind="run" data-id="example">
      ${icon('clock')}查看所属回顾</button>
    <p class="page-demo-note">原话与候选均为预置示例，本次新增反馈不会自动并入这个候选。</p>`;
}

/** @brief 从回顾详情查看采用的原话和形成的候选，不伪造实际定时任务。 */
function runDetail(state) {
  return `<span class="detail-eyebrow">回顾记录 · 示例</span><h2>整理沟通中的纠正</h2>
    <p class="detail-lead">结合原话的要求和限制，整理为有来源、有适用范围的候选。</p>
    <section class="detail-section"><h3>使用的反馈与沟通</h3><div class="review-feedback-list">
      ${sampleFeedback.map(record => renderFeedbackRow(state, record, record.id)).join('')}</div></section>
    <section class="detail-section"><h3>回顾结果</h3>
      <button class="review-related-link" data-action="review-select" data-kind="candidate" data-id="example">
        ${icon('memory')}<span><strong>先说结果，再解释原因</strong><small>表达偏好候选 · 未发布</small></span>
        ${icon('chevron')}</button><p>先给结论，同时保留复杂方案所需依据；不能因简短而省略关键解释。</p></section>
    <section class="detail-section"><h3>仍需判断</h3><p>来源是否充分、适用范围是否合理、反证是否成立，
      以及是否满足采纳条件。不确定和冲突的结论保留原因。</p></section>
    <p class="page-demo-note">这是预置回顾示例，没有运行模型、创建定时任务或发布长期偏好。</p>`;
}

/** @brief 按同一页中的选择切换右侧反馈、回顾或候选详情。 */
export function renderReviewPage(state) {
  const { kind, id } = state.reviewSelection;
  const titles = { feedback: '反馈详情', run: '回顾详情', candidate: '候选详情' };
  const detail = kind === 'feedback' ? renderFeedbackDetail(state, reviewFeedback(state, id))
    : kind === 'run' ? runDetail(state) : candidateDetail(state);
  return { main: reviewMain(state), detailTitle: titles[kind], detail };
}
