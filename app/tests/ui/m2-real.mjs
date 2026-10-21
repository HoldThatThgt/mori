// M2 真实端点走查（方案第 7 节 M2 走查 1–8 与反例），对负责人在 Mori 里填过的端点（DeepSeek）运行。
// 脚本不接触 key：只把走查数据目录里 Mori 加密保存的密文（credentials.json 与 Local State）复制到临时目录。
// 模型每次的做法不完全一样（例如先读文件再改、改两次），所以每轮都"出一张卡处理一张"，直到本轮结束。
// 任务栏闪烁与"Show in Explorer"的做法与 m2-app.mjs 相同：经 app.evaluate 在主进程里记录 flashFrame 调用，
// 开一个小窗口把焦点抢走；shell.showItemInFolder 换成只记路径的版本，不会真的打开资源管理器。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m2-real.mjs --source <走查数据目录> [--exe <Mori.exe>] [--only 1,2,…]
// 结果写到 test-results/m2-real(-packaged).json，截图在 test-results/m2-real(-packaged)/。

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, launch, oneLine, prepareProject, scratchUserData, sleep } from './lib.mjs';
import { pageHelpers } from './page.mjs';

const source = arg('source');
const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
if (!source) throw new Error('Missing --source <user data dir with a saved connection>');
const suffix = exePath ? '-packaged' : '';
const shots = join(appRoot, `test-results/m2-real${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});
const wanted = (item) => !only || only.includes(String(item));

/** 当前显示的会话面板（隐藏的会话面板仍然挂载，找元素都限定在这里） */
const P = '.pane-slot:not([hidden]) ';
const CARD = `${P}[data-testid="approval-card"]`;
const STOPPED = 'Stopped · Changes made so far stay as they are';
const ISSUE_HEADINGS = ['# UI issue · ', '## What went wrong', '## What you expected', '## Screenshot',
  '## Current view', '## Recent activity', '## Versions'];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// 走查 8 在连接表单里填的 key：明显是假的测试值，用来确认它不进报告。
const FAKE_KEY = 'sk-mori-m2-walkthrough-not-in-report';

/** @brief 某个请求的批准卡。 */
const cardFor = (page, requestId) => page.locator(`${CARD}[data-request="${requestId}"]`);
/** @brief 焦点是否在当前会话的输入框里。 */
const composerFocused = (page) => page.evaluate((p) => document.activeElement
  === document.querySelector(`${p}.composer textarea`), P);
/** @brief 当前会话里的工具卡。 */
const toolCards = (page) => page.locator(`${P}[data-testid="tool-card"]`).evaluateAll((cards) => cards.map((card) => ({
  title: card.querySelector('.tool-title')?.textContent ?? '', status: card.dataset.status,
  text: card.querySelector('[data-testid="tool-status"]')?.textContent ?? '',
  badge: card.querySelector('[data-testid="tool-badge"]')?.textContent ?? '' })));
/** @brief 当前会话是否在生成。 */
const running = (page) => page.locator(`${P}[data-testid="chat-pane"]`).getAttribute('data-running');
/** @brief 项目里的文件内容；不存在时为 null。 */
const fileText = (project, name) => {
  const path = join(project, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
};

/** @brief 用 MutationObserver 记下批准卡、阶段行和工具卡状态的每次变化（与 m2-replay.mjs 相同），供反例检查。 */
async function watchApproval(page) {
  await page.evaluate((p) => {
    window.__approvalSamples = [];
    let last = '';
    const sample = () => {
      const pane = document.querySelector(p.trim());
      const card = pane?.querySelector('[data-testid="approval-card"]');
      const stage = pane?.querySelector('[data-testid="stage"]')?.textContent?.replace(/\s\d+(\.\d+)?s$/, '') ?? '';
      const statuses = [...(pane?.querySelectorAll('[data-testid="tool-card"]') ?? [])].map((c) => c.dataset.status);
      const entry = { request: card?.dataset.request ?? null, tool: card?.dataset.tool ?? null, stage,
        running: statuses.filter((s) => s === 'running').length };
      const key = JSON.stringify(entry);
      if (key !== last) { last = key; window.__approvalSamples.push(entry); }
    };
    window.__approvalObserver?.disconnect();
    window.__approvalObserver = new MutationObserver(sample);
    window.__approvalObserver.observe(document.body, { subtree: true, childList: true, characterData: true,
      attributes: true });
  }, P);
}

/** @brief 读批准卡上的内容。 */
function cardInfo(page, requestId) {
  return cardFor(page, requestId).evaluate((el) => ({
    title: el.querySelector('[data-testid="approval-title"]')?.innerText ?? el.innerText.split('\n')[0],
    text: el.innerText,
    edits: [...el.querySelectorAll('[data-testid="approval-edit"]')].map((e) => ({
      old: e.querySelector('.approval-old')?.textContent ?? '',
      new: e.querySelector('.approval-new')?.textContent ?? '' })),
    content: el.querySelector('[data-testid="approval-content"]')?.textContent ?? '',
    command: el.querySelector('[data-testid="approval-command"]')?.textContent ?? '',
    allowSession: el.querySelector('[data-testid="approval-allow-session"]')?.textContent ?? '',
  }));
}

/** @brief 等本轮开始（或发送失败出现错误卡）。 */
async function waitRunning(page) {
  await page.waitForFunction((p) => document.querySelector(`${p}[data-testid="chat-pane"]`)?.dataset.running === 'true'
    || document.querySelectorAll(`${p}[data-testid="error-card"]`).length > 0, P, { timeout: 30000 }).catch(() => {});
}

/** @brief 等一张不在 known 里的批准卡出现，或本轮结束；返回 { request, tool }，本轮结束时为 null。 */
async function nextCard(page, known = [], timeout = 180000) {
  const handle = await page.waitForFunction(({ p, seen }) => {
    const card = document.querySelector(`${p}[data-testid="approval-card"]`);
    if (card && !seen.includes(card.dataset.request)) return { request: card.dataset.request, tool: card.dataset.tool };
    const pane = document.querySelector(`${p}[data-testid="chat-pane"]`);
    return pane?.dataset.running === 'false' && pane?.dataset.sending === 'false' ? { idle: true } : false;
  }, { p: P, seen: known }, { timeout, polling: 100 });
  const value = await handle.jsonValue();
  return value.idle ? null : value;
}

/** @brief 本轮里每出现一张卡就调用 decide(card, 序号)，直到本轮结束；返回出现过的卡（不含 known 里的）。 */
async function answerCards(page, decide, known = []) {
  await waitRunning(page);
  const seen = [];
  const ids = () => [...known, ...seen.map((card) => card.request)];
  for (let card = await nextCard(page, ids()); card; card = await nextCard(page, ids())) {
    seen.push(card);
    await decide(card, seen.length - 1);
    await cardFor(page, card.request).waitFor({ state: 'detached', timeout: 15000 });
  }
  return seen;
}

/** @brief 焦点放进输入框，按 Alt+数字。 */
async function altKey(page, h, digit) {
  await h.textarea.focus();
  await page.keyboard.press(`Alt+${digit}`);
}

/** @brief 每张卡都 Alt+1 允许。 */
const allowAll = (page, h) => () => altKey(page, h, 1);

/** @brief 每张卡都写理由后点"Deny"。 */
const rejectAll = (page, reason) => async (card) => {
  await cardFor(page, card.request).getByTestId('approval-reason').fill(reason);
  await cardFor(page, card.request).getByTestId('approval-reject').click();
};

/** @brief 打开顶栏的权限菜单（已经开着时直接返回）。 */
async function openMenu(page) {
  const menu = page.getByTestId('permission-menu');
  if (!(await menu.isVisible().catch(() => false))) await page.locator(`${P}[data-testid="permission-button"]`).click();
  await menu.waitFor({ timeout: 5000 });
  return menu;
}

/** @brief 权限菜单里"Allowed for this session:"的各行（每行一个"Forget"按钮；返回去掉"Forget"后的文字）。 */
async function allowedRows(page) {
  await openMenu(page);
  return page.getByTestId('permission-allowed').evaluate((list) => [...list.querySelectorAll('button')]
    .filter((button) => button.textContent.includes('Forget'))
    .map((button) => button.parentElement.textContent.replace('Forget', '').trim()));
}

/**
 * @brief 在权限菜单里 Forget 一项"Allowed for this session"，并等这一行消失（最多 5 秒）：列表在后台进程答复 approval.forget 之后才变。
 *        没等到时不报错，由调用方的检查记下失败。
 */
async function forgetRow(page, label) {
  await openMenu(page);
  await page.getByTestId('permission-allowed').locator('*').filter({ hasText: label })
    .filter({ has: page.getByRole('button', { name: 'Forget' }) }).last().getByRole('button', { name: 'Forget' })
    .click();
  await page.waitForFunction((text) => !document.querySelector('[data-testid="permission-allowed"]')?.textContent
    ?.includes(text), label, { timeout: 5000 }).catch(() => {});
}

/** @brief 等本轮结束：不在生成、不在发送、阶段行消失（本轮已经结束时立即返回）。 */
function waitIdle(page, timeout = 120000) {
  return page.waitForFunction((p) => {
    const pane = document.querySelector(`${p}[data-testid="chat-pane"]`);
    return pane?.dataset.running === 'false' && pane?.dataset.sending === 'false'
      && !pane.querySelector('[data-testid="stage"]');
  }, P, { timeout });
}

/** @brief 在同一个文件夹里新建一个会话，等它成为当前会话并可以发送。 */
async function newSession({ app, page, h, project }) {
  const before = await page.locator('.pane-slot').count();
  await h.openFolder(app, project);
  await page.waitForFunction((n) => document.querySelectorAll('.pane-slot').length > n, before, { timeout: 30000 });
  await page.waitForFunction((p) => !document.querySelector(`${p}[data-testid="not-ready"]`), P, { timeout: 30000 });
}

/** @brief 在左栏点名字为 title 的会话，等它成为当前会话。 */
async function switchSession(page, title) {
  await page.locator('.session-item', { hasText: title }).first().click();
  await page.waitForFunction(({ p, name }) => document.querySelector(`${p}[data-testid="session-title"]`)
    ?.textContent === name, { p: P, name: title }, { timeout: 10000 });
}

/** @brief 权限按钮上的文字。 */
const permissionText = (page) => page.locator(`${P}[data-testid="permission-button"]`).innerText()
  .then((text) => text.trim());

/**
 * @brief 等顶栏权限按钮变成 want（最多 5 秒）：按钮在后台进程答复 approval.setMode 之后才变，不能点完马上读。
 * @return 是否等到了
 */
function permissionBecomes(page, want) {
  return page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent?.trim() === text,
    { selector: `${P}[data-testid="permission-button"]`, text: want }, { timeout: 5000 }).then(() => true, () => false);
}

/** @brief 已拒绝的卡之后有没有一条带文字的助手回复。 */
function repliedAfterRejected(page) {
  return page.evaluate((p) => {
    const card = [...document.querySelectorAll(`${p}[data-testid="tool-card"][data-status="rejected"]`)].pop();
    const replies = [...document.querySelectorAll(`${p}[data-testid="assistant"]`)];
    return Boolean(card) && replies.some((reply) => !reply.contains(card)
      && (card.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING) && reply.textContent.trim());
  }, P);
}

/** @brief 反例（走查 1 之前）：读取文件不出卡，读取卡直接完成、没有标签。 */
async function readNoCard({ page, h }) {
  await h.send('读一下 src/a.ts，用一句话告诉我 add 函数做什么。不要修改任何文件，也不要运行命令。');
  const seen = await answerCards(page, allowAll(page, h));
  const cards = await toolCards(page);
  record('反例：读取文件不出卡（读取卡直接完成，没有标签）', seen.length === 0
    && cards.some((c) => c.title.startsWith('Read') && c.status === 'done' && !c.badge), JSON.stringify(cards));
}

/** @brief 走查 1：改一个文件：批准卡显示每处替换的原文和新文；允许后工具卡执行并完成，展开能看到实际 diff。 */
async function item1(ctx) {
  const { page, h, project } = ctx;
  await readNoCard(ctx);
  await h.send('用 edit 工具把 README.md 第一行的标题改成 `# Mori fixture project (edited)`，只改这一行。');
  await answerCards(page, async (card, index) => {
    if (index === 0) {
      const info = await cardInfo(page, card.request);
      record('1 批准卡标题"修改 README.md"，显示每处替换的原文和新文', card.tool === 'edit' && info.title.includes('Edit')
        && info.title.includes('README.md') && info.edits.some((e) => e.old.includes('# Mori fixture project')
          && e.new.includes('(edited)')), oneLine(JSON.stringify(info.edits)));
      await shot(page, '1-edit-card');
    }
    await altKey(page, h, 1);
  });
  const cards = await toolCards(page);
  const index = cards.findLastIndex((card) => card.title.startsWith('Edit'));
  const edit = page.locator(`${P}[data-testid="tool-card"]`).nth(Math.max(0, index));
  await edit.locator('summary').click();
  const diff = await edit.getByTestId('tool-diff').waitFor({ timeout: 5000 }).then(() => true, () => false);
  record('1 允许后工具卡执行并完成，展开能看到实际 diff', index >= 0 && cards[index].status === 'done' && diff,
    JSON.stringify(cards[index]));
  record('1 文件确实改了', fileText(project, 'README.md')?.startsWith('# Mori fixture project (edited)'));
  await shot(page, '1-edit-diff');
}

/** @brief 走查 2：拒绝并写理由：工具卡显示"Denied · 理由"，模型的下一条回复出现在它之后。 */
async function item2({ page, project, h }) {
  const reason = '这句话保持原样，不要改';
  await h.send('用 edit 工具把 README.md 里的 `This folder is used to check Mori against a model.` 改成'
    + ' `This folder checks Mori.`，只改这一句。');
  const seen = await answerCards(page, rejectAll(page, reason));
  const cards = await toolCards(page);
  record('2 拒绝并写理由：工具卡显示"已拒绝 · 理由"', seen.length > 0
    && cards.some((c) => c.status === 'rejected' && c.text === `Denied · ${reason}`), JSON.stringify(cards.slice(-2)));
  record('2 模型的下一条回复出现在已拒绝的卡之后', await repliedAfterRejected(page));
  record('2 文件没有改', fileText(project, 'README.md')?.includes('This folder is used to check Mori against a model.'));
  await shot(page, '2-rejected');
}

/** @brief 走查 3：在输入框打字时出现批准卡：继续打字、按 Enter 都不会批准（Enter 是排队）；Alt+1 允许。 */
async function item3({ page, project, h }) {
  const first = '排队：不要调用任何工具，';
  const rest = '用一句话告诉我 notes.md 里写了什么。';
  await h.send('用 write 工具新建 notes.md，内容只有一行 `hello from mori`。');
  await h.textarea.focus();
  await page.keyboard.type(first);
  const card = await nextCard(page);
  if (!card) throw new Error('no approval card for write');
  record('3 出卡时焦点还在输入框，打的字都在', await composerFocused(page)
    && await h.textarea.inputValue() === first);
  await page.keyboard.type(rest);
  await page.keyboard.press('Enter');
  await page.waitForFunction((text) => document.querySelector('[data-testid="queue"]')?.textContent?.includes(text),
    rest, { timeout: 10000 }).catch(() => {});
  const write = (await toolCards(page)).find((c) => c.title.startsWith('Write'));
  record('3 继续打字并按 Enter 是排队，不会批准', await cardFor(page, card.request).isVisible()
    && write?.status === 'awaiting', JSON.stringify(write));
  await shot(page, '3-typing');
  await altKey(page, h, 1);
  await answerCards(page, allowAll(page, h), [card.request]);
  const users = await page.locator(`${P}[data-testid="user-message"]`).allInnerTexts();
  record('3 Alt+1 允许：写入完成，排队的那条随后送达', fileText(project, 'notes.md')?.trim() === 'hello from mori'
    && users.some((text) => text.startsWith(first)), users.slice(-2).join(' | '));
}

/** @brief 走查 4 前半：第一张命令卡选"Allow “Run commands” for this session"，之后的命令不出卡、标"Allowed for this session"。 */
async function sessionAllow({ page, h }) {
  await h.send('先运行命令 `echo one`，看到结果后再运行命令 `echo two`。两条命令分两次调用，不要合并成一条。');
  const seen = await answerCards(page, async (card, index) => {
    if (index > 0) return altKey(page, h, 1);
    const info = await cardInfo(page, card.request);
    record('4 命令卡：标题"运行命令"、完整命令行、本会话不再询问"运行命令"，下方"之后本会话的所有命令都会直接执行"',
      info.title.includes('Run a command') && info.command.includes('echo one')
        && info.allowSession.includes('Allow “Run commands” for this session')
        && info.text.includes('You won’t be asked again for any command in this session.'),
      oneLine(info.text));
    await shot(page, '4-command-card');
    return altKey(page, h, 2);
  });
  const two = (await toolCards(page)).find((c) => c.title.includes('echo two'));
  record('4 之后的命令不出卡，标"本会话已允许"', seen.length === 1 && two?.badge === 'Allowed for this session'
    && two.status === 'done', JSON.stringify(two));
  const rows = await allowedRows(page);
  record('4 权限菜单里能看到"本会话已允许：运行命令"', rows.some((row) => row.includes('Run commands')), rows.join(' | '));
  await shot(page, '4-menu');
  await page.keyboard.press('Escape');
  return seen[0]?.tool;
}

/** @brief 走查 4：本会话不再询问；权限菜单里能看到并清除；新会话重新询问。 */
async function item4(ctx) {
  const { page, h } = ctx;
  await sessionAllow(ctx);
  // 这时第一个会话已经有消息，名字取自第一条消息，与下面新会话的名字不同。
  const firstTitle = await page.locator(`${P}[data-testid="session-title"]`).innerText();
  await newSession(ctx);
  const rows = await allowedRows(page);
  record('4 新会话从"每次询问"开始，不继承"本会话已允许"', await permissionText(page) === 'Ask each time' && rows.length === 0,
    rows.join(' | '));
  await page.keyboard.press('Escape');
  await h.send('运行命令 `echo fresh`，然后告诉我输出。');
  const fresh = await answerCards(page, allowAll(page, h));
  record('4 新会话重新询问：运行命令又出卡', fresh.length >= 1);
  await switchSession(page, firstTitle);
  await forgetRow(page, 'Run commands');
  const after = await allowedRows(page);
  record('4 在权限菜单里清除"运行命令"', !after.some((row) => row.includes('Run commands')), after.join(' | '));
  await page.keyboard.press('Escape');
  await h.send('再运行命令 `echo three`，然后告诉我输出。');
  const again = await answerCards(page, allowAll(page, h));
  record('4 清除后运行命令又出卡', again.length >= 1);
}

/** @brief 切到全部允许：先弹确认（文字、焦点在"Cancel"），确认后按钮显示"Allow all"。 */
async function confirmAll(page) {
  const menu = await openMenu(page);
  await menu.getByRole('menuitemradio', { name: 'Allow all' }).click();
  const dialog = page.getByTestId('confirm-dialog');
  await dialog.waitFor({ timeout: 5000 });
  const text = await dialog.innerText();
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
  record('5 切到"全部允许"先弹确认："切换到全部允许？编辑、写入和命令都不再询问。"，焦点在"取消"',
    text.includes('Switch to “Allow all”?') && text.includes('Edits, writes, and commands will run without asking.')
      && focused === 'Cancel', oneLine(text));
  await shot(page, '5-confirm');
  await dialog.getByRole('button', { name: 'Allow all', exact: true }).click();
  record('5 确认后顶栏按钮显示"全部允许"', await permissionBecomes(page, 'Allow all'), await permissionText(page));
}

/** @brief 走查 5：切到"Allow all"先弹确认；之后改文件不出卡；切回后又出卡。 */
async function item5({ page, h }) {
  await confirmAll(page);
  await h.send('用 edit 工具在 README.md 末尾追加一行 `- Edited in all-allowed mode.`，不要改别的。');
  const seen = await answerCards(page, allowAll(page, h));
  const edit = (await toolCards(page)).findLast((c) => c.title.startsWith('Edit'));
  record('5 全部允许后改文件不出卡，修改卡标"全部允许"', seen.length === 0 && edit?.badge === 'Allow all'
    && edit.status === 'done', JSON.stringify(edit));
  await shot(page, '5-all-allowed');
  const menu = await openMenu(page);
  await menu.getByRole('menuitemradio', { name: 'Ask each time' }).click();
  const switched = await permissionBecomes(page, 'Ask each time');
  record('5 切回"每次询问"不需要确认', await page.getByTestId('confirm-dialog').count() === 0 && switched,
    await permissionText(page));
  await h.send('运行命令 `echo back`，然后告诉我输出。');
  const back = await answerCards(page, allowAll(page, h));
  record('5 切回后又出卡', back.length >= 1);
}

/** @brief 走查 6：有批准卡时在输入框按 Esc：按拒绝处理，并停止生成。 */
async function escStops({ page, h }) {
  const notices = await page.getByText(STOPPED).count();
  await h.send('运行命令 `sleep 33; echo late`，然后告诉我输出。');
  const card = await nextCard(page);
  if (!card) throw new Error('no approval card for the command');
  await shot(page, '6-card');
  await h.textarea.focus();
  await page.keyboard.press('Escape');
  await waitIdle(page, 60000);
  const sleepCard = (await toolCards(page)).find((c) => c.title.includes('sleep 33'));
  record('6 有批准卡时按 Esc：按拒绝处理（"已拒绝 · 你按了停止"），并停止生成', sleepCard?.status === 'rejected'
    && sleepCard.text === 'Denied · You pressed Stop' && await page.getByText(STOPPED).count() === notices + 1
    && await page.locator(`${P}[data-testid="error-card"]`).count() === 0, JSON.stringify(sleepCard));
  await shot(page, '6-stopped');
}

/** @brief 走查 6（焦点在卡上）：在理由框里按 Esc 只拒绝这张卡，生成继续，焦点回到输入框。 */
async function escOnCard({ page, h }) {
  const reason = '先不要运行';
  const notices = await page.getByText(STOPPED).count();
  await h.send('运行命令 `echo skipped`，然后告诉我输出。');
  const card = await nextCard(page);
  if (!card) throw new Error('no approval card for the command');
  const input = cardFor(page, card.request).getByTestId('approval-reason');
  await input.fill(reason);
  await input.press('Escape');
  await cardFor(page, card.request).waitFor({ state: 'detached', timeout: 10000 });
  record('6 焦点在卡上按 Esc：只拒绝这张卡，生成继续，焦点回到输入框', await running(page) === 'true'
    && await composerFocused(page));
  await answerCards(page, rejectAll(page, reason), [card.request]);
  const skipped = (await toolCards(page)).find((c) => c.title.includes('echo skipped'));
  record('6 焦点在卡上按 Esc：工具卡"已拒绝 · 理由"，没有停止', skipped?.text === `Denied · ${reason}`
    && await page.getByText(STOPPED).count() === notices, JSON.stringify(skipped));
}

/** @brief 走查 6。 */
async function item6(ctx) {
  await escStops(ctx);
  await escOnCard(ctx);
}

// ---------- 主进程里运行的函数（经 app.evaluate 序列化，只能用参数里的 electron 模块；与 m2-app.mjs 相同） ----------

/** @brief 记录主窗口 flashFrame 的调用，再开一个小窗口把焦点抢走。 */
function installFlashRecorder({ BrowserWindow }) {
  const windows = BrowserWindow.getAllWindows();
  const main = windows.find((window) => window.webContents.getURL().includes('index.html')) ?? windows[0];
  const proto = BrowserWindow.prototype;
  const original = proto.flashFrame;
  const state = { calls: [], descriptor: Object.getOwnPropertyDescriptor(proto, 'flashFrame'), mainId: main.id };
  Object.defineProperty(proto, 'flashFrame', { configurable: true, writable: true, value(flag) {
    state.calls.push({ id: this.id, flag });
    return original.call(this, flag);
  } });
  const helper = new BrowserWindow({ width: 320, height: 200, x: 40, y: 40, title: 'focus helper' });
  helper.focus();
  state.helperId = helper.id;
  globalThis.__m2Flash = state;
}

/** @brief 主窗口现在有没有焦点。 */
function mainFocused({ BrowserWindow }) {
  return BrowserWindow.fromId(globalThis.__m2Flash.mainId)?.isFocused() ?? false;
}

/** @brief 记下的主窗口 flashFrame 调用（true / false 序列）。 */
function flashCalls() {
  const { calls, mainId } = globalThis.__m2Flash;
  return calls.filter((call) => call.id === mainId).map((call) => call.flag);
}

/** @brief 关掉小窗口，把焦点交回主窗口。 */
function focusMain({ BrowserWindow }) {
  const state = globalThis.__m2Flash;
  BrowserWindow.fromId(state.helperId)?.destroy();
  const main = BrowserWindow.fromId(state.mainId);
  main?.show();
  main?.focus();
}

/** @brief 系统不肯把焦点交给 Mori 时（测试进程不在前台），直接发出主窗口的 focus 事件。 */
function emitMainFocus({ BrowserWindow }) {
  BrowserWindow.fromId(globalThis.__m2Flash.mainId)?.emit('focus');
}

/** @brief 恢复 flashFrame，关掉小窗口，停止闪烁。 */
function restoreFlash({ BrowserWindow }) {
  const state = globalThis.__m2Flash;
  if (!state) return;
  BrowserWindow.fromId(state.helperId)?.destroy();
  if (state.descriptor) Object.defineProperty(BrowserWindow.prototype, 'flashFrame', state.descriptor);
  else delete BrowserWindow.prototype.flashFrame;
  BrowserWindow.fromId(state.mainId)?.flashFrame(false);
  delete globalThis.__m2Flash;
}

/** @brief 把 shell.showItemInFolder 换成只记路径的版本；换不了时返回 false。 */
function stubShowItem({ shell }) {
  globalThis.__m2Shown = [];
  const stub = (path) => { globalThis.__m2Shown.push(path); };
  try {
    shell.showItemInFolder = stub;
  } catch {
    // 只读属性时下面改用 defineProperty
  }
  if (shell.showItemInFolder !== stub) {
    try {
      Object.defineProperty(shell, 'showItemInFolder', { value: stub, configurable: true, writable: true });
    } catch {
      return false;
    }
  }
  return shell.showItemInFolder === stub;
}

/** @brief 每 100 毫秒在主进程里求一次 fn，直到为真或超时。 */
async function pollMain(app, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await app.evaluate(fn)) return true;
    await sleep(100);
  }
  return false;
}

/** @brief 主窗口在第一次 flashFrame(true) 之后又调用了 flashFrame(false)。 */
function flashStopped() {
  const { calls, mainId } = globalThis.__m2Flash;
  const mine = calls.filter((call) => call.id === mainId);
  const firstTrue = mine.findIndex((call) => call.flag === true);
  return firstTrue >= 0 && mine.slice(firstTrue).some((call) => call.flag === false);
}

/** @brief 走查 7：切到别的窗口等批准：任务栏闪烁；切回 Mori 停止闪烁。 */
async function item7({ app, page, h }) {
  await app.evaluate(installFlashRecorder);
  try {
    await sleep(500);
    const focusedBefore = await app.evaluate(mainFocused);
    await h.send('运行命令 `echo away`，然后告诉我输出。');
    const card = await nextCard(page);
    if (!card) throw new Error('no approval card for the command');
    const flashed = await pollMain(app, () => globalThis.__m2Flash.calls
      .some((call) => call.id === globalThis.__m2Flash.mainId && call.flag === true), 5000);
    record('7 切到别的窗口等批准：任务栏闪烁（flashFrame(true)）', flashed && !focusedBefore,
      `出卡前主窗口有焦点：${focusedBefore}；调用：${JSON.stringify(await app.evaluate(flashCalls))}`);
    await app.evaluate(focusMain);
    let stopped = await pollMain(app, flashStopped, 5000);
    let how = '系统把焦点交回了 Mori';
    if (!stopped && !(await app.evaluate(mainFocused))) {
      await app.evaluate(emitMainFocus);
      stopped = await pollMain(app, flashStopped, 2000);
      how = '系统没有把焦点交给 Mori（测试进程不在前台），测试直接发出主窗口的 focus 事件';
    }
    record('7 切回 Mori：停止闪烁（flashFrame(false)）', stopped, `${how}；调用：${JSON.stringify(await app.evaluate(flashCalls))}`);
    await altKey(page, h, 1);
    await answerCards(page, allowAll(page, h), [card.request]);
  } finally {
    await app.evaluate(restoreFlash).catch((error) => console.error(`[m2-real] restore flashFrame failed: ${error}`));
  }
}

/** @brief Markdown 里"## 标题"下的内容（到下一个"## "为止）。 */
function section(md, title) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/** @brief 两个路径是否指向同一个文件（Windows 不区分大小写）。 */
const samePath = (a, b) => Boolean(a && b) && resolve(a).toLowerCase() === resolve(b).toLowerCase();

/** @brief 填两段文字、保存，返回"Saved to <路径>"里的 Markdown 路径。 */
async function saveIssue(dialog, what, expect) {
  await dialog.getByTestId('issue-what').fill(what);
  if (expect) await dialog.getByTestId('issue-expect').fill(expect);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = dialog.getByTestId('issue-saved');
  await saved.waitFor({ timeout: 15000 });
  return /Saved to\s*(.+?\.md)/.exec(await saved.innerText())?.[1]?.trim() ?? null;
}

/** @brief 检查保存的报告：位置与文件名、各节、截图文件、当前界面、最近的操作与版本。 */
function checkIssueFile({ userData }, issue, { what, expect }) {
  const md = issue && existsSync(issue) ? readFileSync(issue, 'utf8') : '';
  const missing = ISSUE_HEADINGS.filter((heading) => !md.split(/\r?\n/).some((line) => line.startsWith(heading)));
  const shotName = /!\[Screenshot\]\(([^)]+)\)/.exec(section(md, 'Screenshot'))?.[1] ?? '';
  const png = issue && shotName ? join(dirname(issue), shotName) : '';
  const head = png && existsSync(png) ? readFileSync(png).subarray(0, 8) : Buffer.alloc(0);
  record('8 按 F8 写一条：生成带截图的 Markdown 文件（<userData>/ui-issues，以时间命名，同名 .png）',
    md.length > 0 && samePath(dirname(issue), join(userData, 'ui-issues')) && missing.length === 0
      && /^\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?\.md$/.test(basename(issue)) && section(md, 'What went wrong').includes(what)
      && section(md, 'What you expected').includes(expect) && shotName === basename(issue).replace(/\.md$/, '.png')
      && head.equals(PNG_SIGNATURE), `${issue ?? '没有路径'}；缺少：${missing.join('、') || '无'}`);
  const view = section(md, 'Current view');
  const actions = section(md, 'Recent activity');
  const version = section(md, 'Versions');
  record('8 报告附上当前界面（会话、在生成、等你批准 1 张）、带时间的最近操作（含批准卡的选择）和版本',
    /^- Page: Session$/m.test(view) && /^- Running: Yes$/m.test(view) && /^- Pending requests: 1$/m.test(view)
      && /^- \d{2}:\d{2}:\d{2} \S/m.test(actions) && actions.includes('Permission request: ')
      && ['Mori', 'Electron', 'Chromium', 'Node', 'Windows'].every((name) => version.includes(name)),
    oneLine(`${view} | ${actions.split(/\r?\n/).slice(-3).join(' ')} | ${version}`, 400));
}

/** @brief 走查 8 前半：卡挂着时按 F8 写一条并保存；点"Show in Explorer"；F8 和报告框里的 Esc 都不停止生成。 */
async function f8WhileWaiting(ctx) {
  const { app, page, h } = ctx;
  const stubbed = await app.evaluate(stubShowItem);
  await h.send('运行命令 `echo f8`，然后告诉我输出。');
  const card = await nextCard(page);
  if (!card) throw new Error('no approval card for the command');
  await h.textarea.focus();
  await page.keyboard.press('F8');
  const dialog = page.getByTestId('issue-dialog');
  await dialog.getByTestId('issue-shot').waitFor({ timeout: 15000 });
  await shot(page, '8-f8-dialog');
  const text = { what: '批准卡挂着时的界面', expect: '只是走查，不需要处理' };
  const issue = await saveIssue(dialog, text.what, text.expect);
  checkIssueFile(ctx, issue, text);
  if (stubbed) {
    await dialog.getByRole('button', { name: 'Show in Explorer' }).click();
    await pollMain(app, () => globalThis.__m2Shown.length > 0, 5000);
    const shown = await app.evaluate(() => globalThis.__m2Shown);
    record('8 点"打开所在文件夹"：在资源管理器里选中这个文件', shown.some((path) => samePath(path, issue)), shown.join(' | '));
  } else {
    record('8 点"打开所在文件夹"：在资源管理器里选中这个文件', false, '无法替换 shell.showItemInFolder，没有点按钮');
  }
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.keyboard.press('F8');
  await dialog.waitFor({ timeout: 15000 });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  record('8 反例：按 F8、在报告框里按 Esc 都不会停止生成（卡还在）', await cardFor(page, card.request).isVisible()
    && await running(page) === 'true');
  await altKey(page, h, 1);
  await answerCards(page, allowAll(page, h), [card.request]);
}

/** @brief 走查 8 后半：在连接表单里填一个假 key 并保存，再从左栏按钮报告：key 不进报告。放在最后（之后不再请求模型）。 */
async function f8KeyNotInReport({ page, h }) {
  // M6：设置页先是连接列表，填 key 在连接卡的"Edit connection"里（settings.md"编辑连接"；最近的操作记"Save connection <provider>"）。
  await h.editConnection();
  await h.fillConnection({ apiKey: FAKE_KEY });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await h.formMessage();
  await page.getByRole('button', { name: 'Report a UI issue (F8)' }).click();
  const dialog = page.getByTestId('issue-dialog');
  await dialog.getByTestId('issue-shot').waitFor({ timeout: 15000 });
  const issue = await saveIssue(dialog, '设置页的报告', '');
  const md = issue && existsSync(issue) ? readFileSync(issue, 'utf8') : '';
  record('8 反例：连接表单里填过的 key 不出现在报告里（"最近的操作"只记"保存连接"）；左栏按钮与设置页也能报告',
    md.length > 0 && !md.includes(FAKE_KEY) && section(md, 'Recent activity').includes('Save connection')
      && /^- Page: Settings$/m.test(section(md, 'Current view'))
      && section(md, 'What you expected').includes('(left blank)'), issue);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
}

/** @brief 走查 8。 */
async function item8(ctx) {
  await f8WhileWaiting(ctx);
  await f8KeyNotInReport(ctx);
}

/** @brief 反例（整个走查中）：等批准时阶段行只显示"Waiting for your approval"，不显示"Responding…"或工具的"<标题> Ns"；只读工具从不出卡。 */
async function stageCounterExample({ page }) {
  const samples = await page.evaluate(() => window.__approvalSamples ?? []);
  const shown = samples.filter((s) => s.request);
  const wrong = shown.filter((s) => s.stage !== 'Waiting for your approval' || s.running > 0);
  record('反例：等批准时阶段行显示"等你批准"，不显示"生成中"或"执行中"', shown.length > 0 && wrong.length === 0,
    `${shown.length} 次变化；不符合：${JSON.stringify(wrong.slice(0, 3))}`);
  record('反例：读取、搜索、查找、列目录从不出卡', !shown.some((s) => ['read', 'grep', 'find', 'ls'].includes(s.tool)));
}

/** @brief 依次执行一项走查；出错时记录并截图，继续下一项。 */
async function step(ctx, name, fn) {
  try {
    return await fn();
  } catch (error) {
    record(`${name}：流程`, false, oneLine(error, 400));
    await shot(ctx.page, `${name}-error`);
    return undefined;
  }
}

/** @brief 走查数据目录里要有 Mori 保存的连接（只读 models.json 的非机密部分）；没有时在复制密文之前就失败。 */
function requireConnection(dir) {
  const models = JSON.parse(readFileSync(join(dir, 'pi', 'models.json'), 'utf8'));
  if (!models.providers?.['mori-endpoint']) throw new Error(`No saved connection in ${dir}`);
}

requireConnection(source);
const { project, root } = prepareProject('mori-m2-real-');
const userData = scratchUserData(source);
const ctx = { project, userData };
const pageErrors = [];
// 复制密文之后的每一步（包括启动）都在 try 里，出错也会删掉临时目录。
try {
  ctx.app = await launch({ exePath, userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.h = pageHelpers(ctx.page);
  ctx.page.on('pageerror', (error) => pageErrors.push(error.message));
  await ctx.page.getByRole('button', { name: 'Open folder…' }).first().waitFor({ timeout: 60000 });
  await ctx.h.openFolder(ctx.app, project);
  await watchApproval(ctx.page);
  const items = { 1: item1, 2: item2, 3: item3, 4: item4, 5: item5, 6: item6, 7: item7, 8: item8 };
  for (const [item, fn] of Object.entries(items)) {
    if (wanted(item)) await step(ctx, `走查 ${item}`, () => fn(ctx));
  }
  await stageCounterExample(ctx);
} catch (error) {
  record('走查：流程', false, oneLine(error, 400));
} finally {
  record('页面没有报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  await ctx.app?.close().catch(() => {});
  rmSync(userData, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
process.exitCode = write(`m2-real${suffix}.json`) ? 0 : 1;
