// M1 布局检查（回放页面里运行）：分隔线拖动、方向键、双击恢复、宽度保存；800 宽不裁切；字号不小于 12px；输入法 Enter。

import { join } from 'node:path';
import { oneLine, sleep } from './lib.mjs';

/** @brief 页面里所有可见文字的字号；返回小于 12px 的元素描述。 */
export function smallText(page) {
  return page.evaluate(() => {
    const small = [];
    const walk = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) walk(element.shadowRoot);
        const hasText = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
        const placeholder = element.getAttribute?.('placeholder');
        if (!hasText && !placeholder) continue;
        if (element.getClientRects().length === 0) continue;
        const size = parseFloat(getComputedStyle(element).fontSize);
        if (size < 12) small.push(`${element.tagName.toLowerCase()}.${element.className} ${size}px "${element.textContent.trim().slice(0, 20)}"`);
      }
    };
    walk(document);
    return small;
  });
}

/** @brief 一条分隔线的当前值。 */
function separatorValue(page, kind) {
  return page.locator(`[data-resize="${kind}"]`).getAttribute('aria-valuenow').then(Number);
}

/** @brief 拖动分隔线 dx 像素。 */
async function drag(page, kind, dx) {
  const box = await page.locator(`[data-resize="${kind}"]`).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 5; step += 1) await page.mouse.move(x + (dx * step) / 5, y);
  await page.mouse.up();
}

/** @brief 左右分隔线：方向键 20px、拖动、双击恢复默认、刷新后保留。 */
async function dividerChecks(page, h, record) {
  const sidebar = page.locator('[data-resize="sidebar"]');
  const start = await separatorValue(page, 'sidebar');
  await sidebar.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const keyed = await separatorValue(page, 'sidebar');
  await drag(page, 'sidebar', -50);
  const dragged = await separatorValue(page, 'sidebar');
  await sidebar.dblclick();
  const reset = await separatorValue(page, 'sidebar');
  record('divider：左分隔线 → 每次 20px、拖动、双击恢复 260', keyed === start + 40 && dragged === keyed - 50 && reset === 260,
    `${start} → ${keyed} → ${dragged} → ${reset}`);
  await page.getByRole('button', { name: '右栏：本会话的改动' }).click();
  const right = page.locator('[data-resize="workspace"]');
  const rightStart = await separatorValue(page, 'workspace');
  await right.focus();
  await page.keyboard.press('ArrowLeft');
  const rightKeyed = await separatorValue(page, 'workspace');
  await drag(page, 'workspace', -30);
  const rightDragged = await separatorValue(page, 'workspace');
  record('divider：右分隔线 ← 变宽 20px、向左拖变宽', rightKeyed === rightStart + 20 && rightDragged === rightKeyed + 30,
    `${rightStart} → ${rightKeyed} → ${rightDragged}`);
  await sidebar.focus();
  await page.keyboard.press('ArrowLeft');
  const saved = { sidebar: await separatorValue(page, 'sidebar'), workspace: rightDragged };
  await h.load('readme');
  await page.getByRole('button', { name: '右栏：本会话的改动' }).click();
  const after = { sidebar: await separatorValue(page, 'sidebar'), workspace: await separatorValue(page, 'workspace') };
  record('divider：刷新页面后宽度还在', after.sidebar === saved.sidebar && after.workspace === saved.workspace,
    `${JSON.stringify(saved)} → ${JSON.stringify(after)}`);
  await page.locator('[data-resize="workspace"]').dblclick();
  record('divider：右分隔线双击恢复 450', await separatorValue(page, 'workspace') === 450);
}

/** @brief 800×600：左栏收起为图标栏，没有横向溢出，顶栏与输入框完整。 */
async function narrowChecks(page, app, record, shots) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(800, 600));
  await sleep(500);
  const report = await page.evaluate(() => {
    const overflow = (selector) => [...document.querySelectorAll(selector)]
      .filter((element) => element.getClientRects().length && element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.className);
    const outside = [...document.querySelectorAll('.app *')].filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.right > window.innerWidth + 1 && !element.closest('.conversation, .panel-body');
    }).map((element) => element.className || element.tagName);
    return { width: window.innerWidth, page: document.documentElement.scrollWidth,
      sidebar: document.querySelector('.sidebar')?.getBoundingClientRect().width,
      center: document.querySelector('.center')?.getBoundingClientRect().width,
      overflow: overflow('.topbar, .breadcrumb, .topbar-actions, .composer, .composer-bottom, .chat-pane, .right-panel'),
      outside: outside.slice(0, 5) };
  });
  await page.screenshot({ path: join(shots, 'narrow-800.png') });
  record('narrow：800 宽时左栏收起为 60px 图标栏', report.width === 800 && report.sidebar === 60, JSON.stringify(report));
  record('narrow：800 宽时没有内容被裁掉（无横向溢出，中栏至少 300px）', report.page <= 800 && report.overflow.length === 0
    && report.outside.length === 0 && report.center >= 300, JSON.stringify(report));
  const small = await smallText(page);
  record('fonts：800 宽时没有小于 12px 的文字', small.length === 0, small.slice(0, 5).join('; '));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 800));
  await sleep(300);
}

/** @brief 输入法组字时按 Enter 只选词，不发送；组字结束后 Enter 发送。 */
async function imeCheck(page, h, record) {
  await h.load('readme');
  const cdp = await page.context().newCDPSession(page);
  await h.textarea.focus();
  await cdp.send('Input.imeSetComposition', { text: 'zongjie', selectionStart: 7, selectionEnd: 7 });
  await page.keyboard.press('Enter');
  await sleep(300);
  const sentDuring = await page.evaluate(() => window.__replay.status.commands.filter((c) => c.type === 'session.prompt').length);
  await cdp.send('Input.insertText', { text: '总结' });
  const value = await h.textarea.inputValue();
  record('ime：拼音组字时按 Enter 不会发送', sentDuring === 0, `组字中按 Enter 后发出的消息 ${sentDuring} 条；输入框：${oneLine(value)}`);
  await h.textarea.fill('总结一下 README.md');
  await h.textarea.press('Enter');
  await page.getByTestId('user-message').first().waitFor({ timeout: 10000 });
  record('ime：不在组字时 Enter 发送', true);
  await h.idle();
}

/** @brief 布局检查入口。 */
export async function layoutChecks(page, h, { app, record, shots }) {
  await h.load('readme', { speed: 4 });
  await h.send('总结一下 README.md');
  await h.idle();
  await page.getByTestId('tool-card').first().locator('summary').click();
  await page.getByRole('button', { name: '右栏：本会话的改动' }).click();
  let small = await smallText(page);
  // M6 起设置页先是连接列表（settings.md"列表"），表单在"编辑连接"里：等列表读完再量，再量编辑连接的表单。
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByTestId('connection-card').first().waitFor({ timeout: 10000 });
  small = small.concat(await smallText(page));
  await page.getByTestId('connection-card').first().getByRole('button', { name: '编辑连接' }).click();
  await page.getByTestId('connection-form').waitFor({ timeout: 10000 });
  small = small.concat(await smallText(page));
  await page.getByRole('button', { name: '返回会话' }).click();
  record('fonts：会话、工具卡展开、右栏、设置页（连接列表和编辑连接）没有小于 12px 的文字', small.length === 0,
    small.slice(0, 5).join('; '));
  await page.getByRole('button', { name: '右栏：本会话的改动' }).click();
  await dividerChecks(page, h, record);
  await narrowChecks(page, app, record, shots);
  await imeCheck(page, h, record);
}
