/** @brief 创建项目时只收集名称与可选工作目录，不自动生成会话或访问文件系统。 */
export function openNewProject(onCreate) {
  const dialog = document.createElement('dialog');
  dialog.className = 'session-rename-dialog';
  dialog.setAttribute('aria-labelledby', 'new-project-heading');
  dialog.innerHTML = `<form class="session-rename-form new-project-form">
    <h2 id="new-project-heading">新项目</h2><label for="new-project-name">项目名称</label>
    <input id="new-project-name" name="name" required autocomplete="off" maxlength="80" placeholder="例如：产品调研">
    <label for="new-project-directory">工作目录（可选）</label>
    <input id="new-project-directory" name="directory" autocomplete="off" placeholder="填写本地项目目录">
    <p class="page-secondary">创建后加入侧栏，再从项目旁的 ＋ 新建会话。</p>
    <p class="page-demo-note">本次演示只记录项目名称和目录，不创建或读取文件夹。</p>
    <p class="session-rename-error" role="alert"></p><div class="session-rename-buttons">
      <button type="button" class="button" data-project-cancel>取消</button>
      <button type="submit" class="button primary">创建项目</button></div></form>`;
  dialog.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    const values = new FormData(event.target);
    const name = values.get('name').trim();
    if (!name) {
      console.error('Project name must not be empty.');
      dialog.querySelector('.session-rename-error').textContent = 'Enter a project name.';
      return;
    }
    dialog.close();
    onCreate({ name, directory: values.get('directory').trim() });
  });
  dialog.querySelector('[data-project-cancel]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => event.stopPropagation());
  dialog.addEventListener('keydown', event => event.stopPropagation());
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector('input').focus();
}
