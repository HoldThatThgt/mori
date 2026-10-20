// 项目信任询问（docs/v0/screens/sessions.md "项目信任"）：打开带自己扩展或配置的文件夹前问你一次。
// 焦点先在"不信任"，Tab 在复选框和两个按钮之间切换，Esc 等于不信任（不记住）。回答之后焦点回到当前会话的输入框。

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOverlay } from '../state/overlays';
import { useApp, type TrustPrompt } from '../state/store';
import { answerTrust } from '../state/trust';

/** @brief 对话框里 Tab 只在复选框和按钮之间切换。 */
function trapTab(event: React.KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'Tab') return;
  event.preventDefault();
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('input, button')];
  const index = items.indexOf(document.activeElement as HTMLElement);
  const step = event.shiftKey ? -1 : 1;
  items[(index + step + items.length) % items.length]?.focus();
}

/** @brief 一个询问。 */
function TrustPromptDialog({ prompt }: { prompt: TrustPrompt }) {
  const [remember, setRemember] = useState(false);
  const deny = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const textId = useId();
  useOverlay(true, () => answer(false, false));
  useEffect(() => {
    deny.current?.focus();
  }, []);

  function answer(trusted: boolean, keep: boolean) {
    answerTrust(prompt.id, { trusted, remember: keep });
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      document.querySelector<HTMLElement>('.pane-slot:not([hidden]) .composer textarea')?.focus();
    });
  }

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget
      && event.preventDefault()}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={textId}
        data-testid="trust-dialog" onKeyDown={trapTab}>
        <h2 id={titleId}>信任这个文件夹？</h2>
        <p id={textId}>这个文件夹带有自己的扩展或配置，信任后它们会在你的电脑上运行。</p>
        <p className="dialog-path" data-testid="trust-path">{prompt.cwd}</p>
        {prompt.readError && <p className="form-message error">读取已记住的选择失败：{prompt.readError}</p>}
        <label className="check-row">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          <span>记住</span>
        </label>
        <div className="dialog-actions">
          <button className="button warn" onClick={() => answer(true, remember)}>信任</button>
          <button ref={deny} className="button" onClick={() => answer(false, remember)}>不信任</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** @brief 一次显示最前面的询问；在根组件旁挂一次，首次启动和工作区都能用。 */
export function TrustDialog() {
  const prompt = useApp((state) => state.trustPrompts[0]);
  return prompt ? <TrustPromptDialog key={prompt.id} prompt={prompt} /> : null;
}
