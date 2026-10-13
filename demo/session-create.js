import { projectOptions } from './projects.js';

/** @brief 新建会话先明确项目与名称，取消不会生成条目。 */
export function openNewSession(state, project, onCreate) {
  const dialog = document.createElement('dialog');
  dialog.className = 'session-rename-dialog';
  dialog.setAttribute('aria-labelledby', 'new-session-heading');
  dialog.innerHTML = `<form class="session-rename-form new-session-form">
    <h2 id="new-session-heading">新建会话</h2><label for="new-session-project">所属项目</label>
    <select id="new-session-project" name="project">${projectOptions(state, project)}</select>
    <label for="new-session-title">会话名称</label><input id="new-session-title" name="title"
      value="新会话" required autocomplete="off" maxlength="100">
    <p class="page-secondary">创建后显示在所选项目下，消息和草稿独立保存。</p>
    <p class="session-rename-error" role="alert"></p><div class="session-rename-buttons">
      <button type="button" class="button" data-create-cancel>取消</button>
      <button type="submit" class="button primary">创建会话</button></div></form>`;
  dialog.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    const form = new FormData(event.target);
    const title = form.get('title').trim();
    if (!title) {
      console.error('Session name must not be empty.');
      dialog.querySelector('.session-rename-error').textContent = 'Enter a session name.';
      return;
    }
    dialog.close();
    onCreate(form.get('project'), title);
  });
  dialog.querySelector('[data-create-cancel]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => event.stopPropagation());
  dialog.addEventListener('keydown', event => event.stopPropagation());
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector('input').select();
}
