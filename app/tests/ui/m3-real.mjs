// M3 真实端点走查（方案第 7 节 M3 走查 1–7 与反例，加上负责人 2026-10-19 决定照 Claude 桌面版之后的归档与删除、
// 扩展的询问、界面重新加载），对负责人在 Mori 里填过的端点（DeepSeek）运行。
// 状态表见 docs/v0/screens/sessions.md 与 extension-ui.md。脚本不接触 key：只把走查数据目录里 Mori 加密保存的密文
// （credentials.json 与 Local State）复制到临时目录，整个走查（包括每次重启）都用这一个复制出来的数据目录。
// 像负责人一样操作界面：点会话行、右键菜单、Ctrl+N、Shift+Tab、Shift+F10、Enter、信任询问、询问卡；"重启"是关掉窗口
// （Mori 照常有序退出）再用同一个数据目录启动；"界面重新加载"是 page.reload()（与 Ctrl+R 相同，后台进程不停）。
// 系统的选文件夹对话框经 app.evaluate 换成直接返回测试文件夹。
// 走查 4 用 Mori 自己的归档与删除：删除是永久的，只删临时数据目录里的测试会话；删除后核对文件不在了，
// 并用 PowerShell（Shell.Application 的回收站）按原位置和文件名核对它没有进回收站。脚本不清空回收站。
// 走查 5 与反例用会写标记文件的项目扩展（.pi/extensions/project-hello.ts，注册工具 project_hello）：
// 标记文件出现说明扩展的代码运行了；信任之后标记文件出现，作为"没有出现"这一判断的对照。
// 走查 e 用信任的项目扩展（.pi/extensions/project-ask.ts，注册工具 project_ask：经 ctx.ui 通知一次，再依次确认、
// 选择、输入）。走查 r 用带 .pi/settings.json 的文件夹（要问信任），信任但不记住：重新加载后点开还在生成的会话不问信任。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m3-real.mjs --source <走查数据目录> [--exe <Mori.exe>] [--only 1,2,…,7,e,r,c]
// e 是扩展的询问，r 是界面重新加载，c 是反例（Esc、本次运行里同一文件夹、问过之后才出现 .pi/extensions）。
// 各项按 1–7、e、r、c 的顺序执行；单独执行某一项时，它需要的会话由脚本先建好（走查 1 的四个会话）。
// 结果写到 test-results/m3-real(-packaged).json，截图在 test-results/m3-real(-packaged)/。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  allowRealProject, appRoot, arg, createRecorder, launch, oneLine, prepareProject, realProviders, scratchUserData,
  sleep,
} from './lib.mjs';
import { pageHelpers } from './page.mjs';

const source = arg('source');
const exePath = arg('exe') ? resolve(arg('exe')) : null;
const only = arg('only')?.split(',');
if (!source) throw new Error('Missing --source <user data dir with a saved connection>');
const suffix = exePath ? '-packaged' : '';
const shots = join(appRoot, `test-results/m3-real${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});
const wanted = (item) => !only || only.includes(String(item));

/** 当前显示的会话面板（隐藏的会话面板仍然挂载，找元素都限定在这里） */
const P = '.pane-slot:not([hidden]) ';
const CARD = `${P}[data-testid="approval-card"]`;
const QUESTION = `${P}[data-testid="ext-ui-card"]`;
/** 走查 1 的四条消息：两个文件夹各两个会话；开头各不相同，侧栏的前 20 个字能区分 */
const MESSAGES = {
  a1: '请用一句话介绍你自己，并说明你能帮我做什么。不要调用任何工具。',
  a2: '请用一句话说明 README 文件通常写些什么内容。不要调用任何工具。',
  b1: '请用一句话解释什么是版本控制以及它为什么有用。不要调用任何工具。',
  b2: '请用一句话说说写单元测试有哪些好处，越简短越好。不要调用任何工具。',
};
/** 走查 2 里用键盘新建、改名后发的第一条消息 */
const B3_MESSAGE = '不要调用任何工具，用一句话回答：键盘快捷键有什么好处？';
const NAMES = { keyboard: 'M3 键盘改名', opened: 'M3 改过名的会话', unopened: 'M3 没打开时改名' };
/** 走查 4：生成时间够打开右键菜单的问题 */
const MEDIUM = '不要调用任何工具。请写两段简短的文字，每段三四句话：第一段讲早晨，第二段讲傍晚。';
/** 走查 4：归档前在会话里写下的草稿（归档保留草稿，删除时一起删除） */
const ARCHIVE_DRAFT = '归档前写下的草稿';
/** 走查 7：生成时间够切到别的会话再看侧栏的问题 */
const LONG = '不要调用任何工具。请写三段文字，每段四五句话：第一段讲春天，第二段讲夏天，第三段讲秋天。';
/** 走查 r：生成时间够重新加载界面、再点开接上的问题 */
const RELOAD_LONG = '不要调用任何工具。请写五段文字，每段五六句话：依次讲春天、夏天、秋天、冬天，最后一段总结一年四季。';
const RELOAD_DRAFT = '重新加载前写下的草稿';
const LIST_TOOLS = '不要调用任何工具。请列出你现在可以调用的全部工具名，用逗号分隔。';
const HELLO_TOOL = 'project_hello';
const HELLO_TEXT = 'hello from project';
const CALL_HELLO = `请调用 ${HELLO_TOOL} 工具，然后告诉我它返回了什么。`;
/**
 * 走查 5：信任之后，在不信任时保存的会话里再让模型调用 project_hello。这个会话里模型先前说过没有这个工具，
 * 只说"再调用一次"时 DeepSeek 曾改用 bash 去查 .pi 文件夹，所以写明工具已经可用、直接调用它。
 */
const CALL_HELLO_AGAIN = `${HELLO_TOOL} 工具现在已经可用了。请直接调用 ${HELLO_TOOL} 工具（不要用 bash 或其他工具去查），`
  + '然后告诉我它返回了什么。';
/** 走查 e：项目扩展的询问工具；通知、三个询问的文字，以及作答用的选项和词（模型的回复里要提到它们） */
const ASK_TOOL = 'project_ask';
const ASK = {
  note: 'project_ask will ask you three questions',
  confirm: { title: 'Continue?', message: 'project_ask wants to ask two more questions.' },
  select: { title: 'Pick a color', options: ['red', 'green', 'blue'], answer: 'green' },
  input: { title: 'Type a word', placeholder: 'any single word', answer: 'pinecone', timeoutMs: 180000 },
};
const CALL_ASK = `请调用 ${ASK_TOOL} 工具（它会问我几个问题），然后用一句话告诉我它返回的结果，`
  + '原样写出其中 color 和 word 的值。';
const DRAFTS = { a: '这是一段写了一半的草稿，切走再回来还要', b: '另一个会话里的草稿' };
const PICK_HINT = 'Pick a session on the left to continue, or open a folder to start a new session.';
const UNTRUSTED = 'This workspace isn’t trusted, so its extensions and settings weren’t loaded · '
  + 'You’ll be asked again after you restart Mori';
const TRUST_TEXT = 'This workspace has its own extensions or settings. If you trust it, they’ll run on your computer.';
/** pi 的内置工具名（问模型能用哪些工具时，回答里至少要有一个） */
const BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
/** 读回收站：每项一行"名字|原位置|回收站里的路径" */
const RECYCLE_SCRIPT = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$bin = (New-Object -ComObject Shell.Application).NameSpace(10)',
  'foreach ($item in $bin.Items()) {',
  "  $from = $item.ExtendedProperty('System.Recycle.DeletedFrom')",
  '  if (-not $from) { $from = $bin.GetDetailsOf($item, 1) }',
  '  "$($item.Name)|$from|$($item.Path)"',
  '}',
].join('\n');

// ---------- 测试项目 ----------

/** @brief 项目扩展 project-hello.ts 的源文件：注册 project_hello；加载时把当前时间写进 marker（证明扩展的代码运行了）。 */
function extensionSource(marker) {
  return [
    "import { writeFileSync } from 'node:fs';",
    '',
    'export default function (pi) {',
    `  writeFileSync(${JSON.stringify(marker)}, new Date().toISOString());`,
    '  pi.registerTool({',
    `    name: '${HELLO_TOOL}',`,
    "    label: 'Project hello',",
    "    description: 'Returns a greeting from the project extension (test tool).',",
    "    parameters: { type: 'object', properties: {}, additionalProperties: false },",
    '    async execute() {',
    `      return { content: [{ type: 'text', text: '${HELLO_TEXT}' }], details: {} };`,
    '    },',
    '  });',
    '}',
    '',
  ].join('\n');
}

/**
 * @brief 项目扩展 project-ask.ts 的源文件：注册 project_ask，执行时经 ctx.ui 通知一次（warning），再依次确认、选择、
 *        输入（输入带超时）；取消了就提前返回，不再问后面的。返回作答的结果。
 */
function askExtensionSource() {
  const q = (value) => JSON.stringify(value);
  return [
    'export default function (pi) {',
    '  pi.registerTool({',
    `    name: '${ASK_TOOL}',`,
    "    label: 'Project ask',",
    "    description: 'Asks the user three questions through the extension UI and returns the answers (test tool).',",
    "    parameters: { type: 'object', properties: {}, additionalProperties: false },",
    '    async execute(_id, _params, signal, _onUpdate, ctx) {',
    "      const done = (text) => ({ content: [{ type: 'text', text }], details: {} });",
    `      ctx.ui.notify(${q(ASK.note)}, 'warning');`,
    `      const ok = await ctx.ui.confirm(${q(ASK.confirm.title)}, ${q(ASK.confirm.message)}, { signal });`,
    "      if (!ok) return done('confirm=false');",
    `      const color = await ctx.ui.select(${q(ASK.select.title)}, ${q(ASK.select.options)}, { signal });`,
    "      if (!color) return done('confirm=true; color=(cancelled)');",
    `      const word = await ctx.ui.input(${q(ASK.input.title)}, ${q(ASK.input.placeholder)},`,
    `        { signal, timeout: ${ASK.input.timeoutMs} });`,
    "      return done(`confirm=true; color=${color}; word=${word ?? '(cancelled)'}`);",
    '    },',
    '  });',
    '}',
    '',
  ].join('\n');
}

/** @brief 在项目里写一个文件（relative 是相对项目的路径，按需建文件夹）。 */
function writeProjectFile(project, relative, content) {
  const path = join(project, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** @brief 给项目加上 .pi/extensions/project-hello.ts。 */
function writeExtension(project, marker) {
  writeProjectFile(project, join('.pi', 'extensions', 'project-hello.ts'), extensionSource(marker));
}

/** @brief 在 root 下准备名为 name 的项目（内容见 lib.mjs prepareProject）；marker 不为空时带项目扩展。 */
function makeProject(root, name, marker = null) {
  const made = prepareProject('mori-m3-real-');
  const project = join(root, name);
  renameSync(made.project, project);
  rmSync(made.root, { recursive: true, force: true });
  if (marker) writeExtension(project, marker);
  return project;
}

/**
 * @brief 走查用的全部文件夹（名字各不相同）和标记文件（放在项目外）。m3-late 一开始没有 .pi，反例里再加；
 *        m3-ask 带 project_ask（走查 e）；m3-reload 只带 .pi/settings.json（要问信任，走查 r）。
 */
function makeDirs(root) {
  const markers = { ext: join(root, 'ext-ran.txt'), ext2: join(root, 'ext-esc-ran.txt'),
    late: join(root, 'late-ran.txt') };
  const ask = makeProject(root, 'm3-ask');
  writeProjectFile(ask, join('.pi', 'extensions', 'project-ask.ts'), askExtensionSource());
  const reload = makeProject(root, 'm3-reload');
  writeProjectFile(reload, join('.pi', 'settings.json'), '{}\n');
  return { markers, alpha: makeProject(root, 'm3-alpha'), beta: makeProject(root, 'm3-beta'),
    ext: makeProject(root, 'm3-ext', markers.ext), ext2: makeProject(root, 'm3-ext-esc', markers.ext2),
    late: makeProject(root, 'm3-late'), ask, reload };
}

// ---------- 页面上的小工具 ----------

/** @brief CSS 属性选择器里的字符串（会话文件路径里有反斜杠）。 */
const cssString = (value) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
/** @brief 会话文件是 file 的会话行（项目下的，或展开的"Archived"里的）。 */
const rowOf = (page, file) => page.locator(`.session-item[data-file="${cssString(file)}"]`);
/** @brief 一张批准卡或询问卡（nextCard 返回的 card）。 */
const cardOf = (page, card) => page.locator(`${card.kind === 'question' ? QUESTION : CARD}`
  + `[data-request="${card.request}"]`);
/** @brief 两个路径是否指向同一个文件或文件夹（Windows 不区分大小写）。 */
const samePath = (a, b) => Boolean(a && b) && resolve(a).toLowerCase() === resolve(b).toLowerCase();
const chars = (text) => [...text.replace(/\s+/g, ' ').trim()];
/** @brief 第一条消息的前 20 个字（改名框预先填的，不带"…"）。 */
const first20 = (text) => chars(text).slice(0, 20).join('');
/** @brief 侧栏应显示的会话名：前 20 个字，超出加"…"。 */
const expectedTitle = (text) => (chars(text).length > 20 ? `${first20(text)}…` : chars(text).join(''));
/** @brief 顶栏的会话名。 */
const topTitle = (page) => page.locator(`${P}[data-testid="session-title"]`).textContent();
/** @brief 当前会话的信任横幅；没有时为 null。 */
const bannerText = (page) => page.evaluate((p) => document.querySelector(`${p}[data-testid="trust-banner"]`)
  ?.textContent ?? null, P);
/** @brief 当前会话输入框位置的"Starting…"等文字；能发送时为 null。 */
const notReadyText = (page) => page.evaluate((p) => document.querySelector(`${p}[data-testid="not-ready"]`)
  ?.textContent ?? null, P);
/** @brief 焦点是否在当前会话的输入框里。 */
const composerFocused = (page) => page.evaluate((p) => document.activeElement
  === document.querySelector(`${p}.composer textarea`), P);
/** @brief 当前会话是否在生成（'true' / 'false'；没有会话时为 null）。 */
const running = (page) => page.evaluate((p) => document.querySelector(`${p}[data-testid="chat-pane"]`)
  ?.dataset.running ?? null, P);
/** @brief 中栏"Open a folder"的标题；中栏显示会话时为 null。 */
const centerHeading = (page) => page.evaluate(() => document.querySelector('[data-testid="open-folder"] h2')
  ?.textContent ?? null);

/** @brief 焦点所在的元素：是否在会话树里、会话行标识、简短的名字和角色。 */
function focusInfo(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    const label = el?.getAttribute('aria-label') || el?.textContent?.trim() || el?.tagName || '';
    return { inTree: Boolean(el?.closest('[data-testid="session-tree"]')), row: el?.dataset?.row ?? null,
      role: el?.getAttribute('role') ?? null, label: label.slice(0, 40) };
  });
}

/** @brief 会话树：每个项目的工作目录、显示的文件夹名、悬停路径和会话行（不含"Archived"里的）。 */
function treeGroups(page) {
  const selector = '[data-testid="session-tree"] .project-group';
  return page.evaluate((groups) => [...document.querySelectorAll(groups)].map((group) => {
    const heading = group.querySelector('.project-heading');
    return { cwd: group.dataset.cwd, name: heading?.textContent ?? '', path: heading?.getAttribute('title') ?? '',
      rows: [...group.querySelectorAll('.session-item')].map((row) => ({ id: row.dataset.row, file: row.dataset.file,
        label: row.querySelector('.session-label')?.textContent ?? '', full: row.getAttribute('title') ?? '',
        active: row.getAttribute('aria-selected') === 'true',
        status: row.querySelector('[data-testid="session-status"]')?.dataset.status ?? null,
        statusText: row.querySelector('[data-testid="session-status"]')?.textContent ?? '' })) };
  }), selector);
}

/** @brief 项目下的全部会话行（带所在项目的工作目录）。 */
const allRows = async (page) => (await treeGroups(page)).flatMap((g) => g.rows.map((row) => ({ ...row, cwd: g.cwd })));
/** @brief 项目下会话文件是 file 的会话行；没有时为 null。 */
const rowByFile = async (page, file) => (await allRows(page)).find((row) => row.file === file) ?? null;

/** @brief 等会话行的状态变成 statuses 之一（'none' 表示没有状态）。 */
function waitRowStatus(page, file, statuses, timeout) {
  return page.waitForFunction(({ f, list }) => {
    const row = [...document.querySelectorAll('.session-item')].find((item) => item.dataset.file === f);
    return list.includes(row?.querySelector('[data-testid="session-status"]')?.dataset.status ?? 'none');
  }, { f: file, list: statuses }, { timeout, polling: 100 });
}

/** @brief 等会话行显示 label（改名后重新读取列表有一点延迟）。 */
function waitLabel(page, file, label) {
  return page.waitForFunction(({ f, text }) => [...document.querySelectorAll('.session-item')]
    .find((row) => row.dataset.file === f)?.querySelector('.session-label')?.textContent === text,
  { f: file, text: label }, { timeout: 10000 }).then(() => true, () => false);
}

/** @brief 当前会话的对话：你的消息和每条回复的正文（比较重启前后用）。 */
function conversation(page) {
  return page.evaluate((p) => {
    const pane = document.querySelector(`${p}[data-testid="chat-pane"]`);
    if (!pane) return { users: [], replies: [] };
    const users = [...pane.querySelectorAll('[data-testid="user-message"]')].map((el) => el.textContent.trim());
    const replies = [...pane.querySelectorAll('[data-testid="assistant"]')]
      .map((el) => [...el.querySelectorAll('.prose')].map((prose) => prose.textContent.trim()).join('\n'))
      .filter(Boolean);
    return { users, replies };
  }, P);
}

/** @brief 当前会话最后一条回复的正文。 */
const lastReply = async (page) => (await conversation(page)).replies.at(-1) ?? '';

/** @brief 等当前会话最后一条回复比 length 个字更长（最多 60 秒）；返回是否等到。 */
function waitReplyLonger(page, length) {
  return page.waitForFunction(({ p, n }) => {
    const replies = [...document.querySelectorAll(`${p}[data-testid="assistant"]`)];
    const text = [...(replies.at(-1)?.querySelectorAll('.prose') ?? [])].map((el) => el.textContent.trim()).join('\n');
    return [...text.replace(/\s+/g, ' ').trim()].length > n;
  }, { p: P, n: length }, { timeout: 60000, polling: 200 }).then(() => true, () => false);
}

/** @brief 当前会话里的工具卡。 */
const toolCards = (page) => page.locator(`${P}[data-testid="tool-card"]`).evaluateAll((cards) => cards.map((card) => ({
  title: card.querySelector('.tool-title')?.textContent ?? '', status: card.dataset.status })));

/** @brief localStorage 里有没有这个会话的草稿（"草稿一起删除"在界面上看不到，只能这样查）。 */
const hasDraft = (page, file) => page.evaluate((f) => {
  try {
    return Boolean(JSON.parse(localStorage.getItem('mori.drafts') ?? '{}')[f]);
  } catch {
    return null;
  }
}, file);

// ---------- 右键菜单与已归档 ----------

/** @brief 在会话行上右键，等菜单出现。 */
async function openMenu(page, file) {
  await rowOf(page, file).click({ button: 'right' });
  await page.getByTestId('session-menu').waitFor({ timeout: 5000 });
}

/** M5 加进会话菜单的两项（由 M5 的测试检查，与 m3-replay、m3-helpers 相同）；这里的菜单检查只看 M3 的几项 */
const M5_MENU_ITEMS = ['Attach as context', 'Open in split view'];
/** @brief 开着的右键菜单里的菜单项：文字（含旁边的小字）和是否不可用；不含 M5 加的两项。 */
const menuItems = async (page) => (await page.getByTestId('session-menu').getByRole('menuitem')
  .evaluateAll((els) => els.map((el) => ({ label: el.firstChild?.textContent ?? '', text: el.textContent,
    disabled: el.disabled })))).filter((item) => !M5_MENU_ITEMS.includes(item.label));
/** @brief 菜单项连成一行：文字（含小字），不可用的加"（不可用）"。 */
const menuText = (items) => items.map((item) => `${item.text}${item.disabled ? '（不可用）' : ''}`).join(' / ');
/** @brief 点开头是 label 的菜单项。 */
const pickMenu = (page, label) => page.getByTestId('session-menu')
  .getByRole('menuitem', { name: new RegExp(`^${label}`) }).click();

/** @brief 本机记下的已归档会话文件（localStorage 的 mori.archived）；读不出时为 null。 */
const storedArchived = (page) => page.evaluate(() => {
  try {
    return JSON.parse(localStorage.getItem('mori.archived') ?? '[]');
  } catch {
    return null;
  }
});

/** @brief 侧栏底部的"Archived"：开关上的文字、是否展开、展开时列出的会话行（会话文件、会话名、悬停文字）。 */
function archivedState(page) {
  return page.evaluate(() => {
    const toggle = document.querySelector('[data-testid="archived-toggle"]');
    const list = document.querySelector('[data-testid="archived-list"]');
    const rows = list ? [...list.querySelectorAll('.session-item.archived')].map((row) => ({ file: row.dataset.file,
      label: row.querySelector('.session-label')?.textContent ?? '', title: row.getAttribute('title') ?? '' })) : null;
    return { toggle: toggle?.textContent ?? null, expanded: toggle?.getAttribute('aria-expanded') ?? null, rows };
  });
}

/** @brief 展开"Archived"（已经展开时不动）。 */
async function expandArchived(page) {
  const toggle = page.getByTestId('archived-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.getByTestId('archived-list').waitFor({ timeout: 5000 });
}

/** @brief 等会话 file 归档好（want 为真）或恢复好：本机的已归档列表和项目下的会话行都对上；超时返回 false。 */
function waitArchived(page, file, want) {
  return page.waitForFunction(({ f, archived }) => {
    let stored;
    try {
      stored = JSON.parse(localStorage.getItem('mori.archived') ?? '[]');
    } catch {
      return false;
    }
    const inProject = [...document.querySelectorAll('.project-group .session-item')]
      .some((row) => row.dataset.file === f);
    return stored.includes(f) === archived && inProject !== archived;
  }, { f: file, archived: want }, { timeout: 15000 }).then(() => true, () => false);
}

/** @brief 侧栏里排在会话 file 下面的会话行的标识（没有时上一行；再没有时为 null）。 */
async function rowBelow(page, file) {
  const order = await page.evaluate(() => [...document.querySelectorAll('.session-item')]
    .map((row) => ({ id: row.dataset.row, file: row.dataset.file })));
  const index = order.findIndex((row) => row.file === file);
  return order[index + 1]?.id ?? order[index - 1]?.id ?? null;
}

// ---------- 等待、批准卡与询问卡 ----------

/** @brief 等当前会话可以发送（不再"Starting…"）。 */
function waitReady(page, timeout = 60000) {
  return page.waitForFunction((p) => {
    const pane = document.querySelector(`${p}[data-testid="chat-pane"]`);
    return Boolean(pane) && !pane.querySelector('[data-testid="not-ready"]');
  }, P, { timeout });
}

/** @brief 等本轮开始（或发送失败出现错误卡）。 */
async function waitRunning(page) {
  await page.waitForFunction((p) => document.querySelector(`${p}[data-testid="chat-pane"]`)?.dataset.running === 'true'
    || document.querySelectorAll(`${p}[data-testid="error-card"]`).length > 0, P, { timeout: 30000 }).catch(() => {});
}

/** @brief 等本轮结束：不在生成、不在发送、阶段行消失。 */
function waitIdle(page, timeout = 180000) {
  return page.waitForFunction((p) => {
    const pane = document.querySelector(`${p}[data-testid="chat-pane"]`);
    return pane?.dataset.running === 'false' && pane?.dataset.sending === 'false'
      && !pane.querySelector('[data-testid="stage"]');
  }, P, { timeout });
}

/**
 * @brief 等一张不在 known 里的批准卡或扩展询问卡出现，或本轮结束。返回 { kind: 'approval' | 'question', key,
 *        request, tool, method }（key 是卡的种类加请求 id，放进 known 用），本轮结束时为 null。
 */
async function nextCard(page, known = [], timeout = 240000) {
  const handle = await page.waitForFunction(({ p, cards, seen }) => {
    const card = [...document.querySelectorAll(cards)]
      .find((el) => !seen.includes(`${el.dataset.testid}:${el.dataset.request}`));
    if (card) {
      return { kind: card.dataset.testid === 'ext-ui-card' ? 'question' : 'approval',
        key: `${card.dataset.testid}:${card.dataset.request}`, request: card.dataset.request,
        tool: card.dataset.tool ?? null, method: card.dataset.method ?? null };
    }
    const pane = document.querySelector(`${p}[data-testid="chat-pane"]`);
    return pane?.dataset.running === 'false' && pane?.dataset.sending === 'false' ? { idle: true } : false;
  }, { p: P, cards: `${CARD}, ${QUESTION}`, seen: known }, { timeout, polling: 100 });
  const value = await handle.jsonValue();
  return value.idle ? null : value;
}

/** @brief 本轮里每出现一张卡就调用 decide(card)，直到本轮结束；返回出现过的卡（不含 known 里的）。 */
async function answerCards(page, decide, known = []) {
  await waitRunning(page);
  const seen = [];
  const keys = () => [...known, ...seen.map((card) => card.key)];
  for (let card = await nextCard(page, keys()); card; card = await nextCard(page, keys())) {
    seen.push(card);
    await decide(card);
    await cardOf(page, card).waitFor({ state: 'detached', timeout: 15000 });
  }
  return seen;
}

/** @brief 焦点放进当前会话的输入框，按 Alt+数字（1 允许、3 拒绝）。 */
async function altKey(ctx, digit) {
  await ctx.h.textarea.focus();
  await ctx.page.keyboard.press(`Alt+${digit}`);
}

/** @brief 拒绝一张卡：批准卡 Alt+3；询问卡点"No"（确认）或"Cancel"（选择、输入）。 */
async function rejectCard(ctx, card) {
  if (card.kind === 'approval') return altKey(ctx, 3);
  const name = card.method === 'confirm' ? 'No' : 'Cancel';
  await cardOf(ctx.page, card).getByRole('button', { name, exact: true }).click();
}

/** @brief 等本轮结束；途中的卡按 decide 处理，默认拒绝（这些问题都不需要工具）。返回出现过的卡。 */
async function settle(ctx, decide = (card) => rejectCard(ctx, card)) {
  const cards = await answerCards(ctx.page, decide);
  await waitIdle(ctx.page);
  return cards;
}

// ---------- 打开、新建、切换、重启 ----------

/** @brief 等中栏多出一个会话面板（新建的会话已加入）。 */
const waitNewPane = (page, before) => page.waitForFunction((n) => document.querySelectorAll('.pane-slot').length > n,
  before, { timeout: 30000 });

/** @brief 让系统的选文件夹对话框直接返回 folder，再点左栏的"Open folder…"，等新会话加入。 */
async function openNew(ctx, folder) {
  const before = await ctx.page.locator('.pane-slot').count();
  await ctx.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, folder);
  await ctx.page.getByRole('button', { name: 'Open folder…' }).first().click();
  await waitNewPane(ctx.page, before);
}

/** @brief 按 Ctrl+N，等新会话加入。 */
async function pressCtrlN(ctx) {
  const before = await ctx.page.locator('.pane-slot').count();
  await ctx.page.keyboard.press('Control+N');
  await waitNewPane(ctx.page, before);
}

/** @brief 新会话加入后：等信任询问出现（'dialog'）或会话可以发送（'ready'）。 */
async function dialogOrReady(page, timeout = 60000) {
  const handle = await page.waitForFunction((p) => {
    if (document.querySelector('[data-testid="trust-dialog"]')) return 'dialog';
    const pane = document.querySelector(`${p}[data-testid="chat-pane"]`);
    return pane && !pane.querySelector('[data-testid="not-ready"]') ? 'ready' : false;
  }, P, { timeout, polling: 50 });
  return handle.jsonValue();
}

/** @brief 选文件夹新建会话，返回先看到的是信任询问还是可以发送的会话。 */
async function openAndSee(ctx, folder) {
  await openNew(ctx, folder);
  return dialogOrReady(ctx.page);
}

/** @brief 在信任询问里选"Trust workspace"（不勾"Remember my choice"），等会话可以发送。 */
async function trustOnce(page) {
  const dialog = page.getByTestId('trust-dialog');
  await dialog.getByRole('button', { name: 'Trust workspace', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  await waitReady(page);
}

/** @brief 记下之后有没有出现过信任询问（询问可能一闪而过，轮询抓不到）。 */
function watchTrustDialog(page) {
  return page.evaluate(() => {
    window.__trustSeen = Boolean(document.querySelector('[data-testid="trust-dialog"]'));
    window.__trustObserver?.disconnect();
    window.__trustObserver = new MutationObserver(() => {
      if (document.querySelector('[data-testid="trust-dialog"]')) window.__trustSeen = true;
    });
    window.__trustObserver.observe(document.body, { childList: true, subtree: true });
  });
}
const trustDialogSeen = (page) => page.evaluate(() => window.__trustSeen === true);

/** @brief 当前会话的会话文件（当前会话行的 data-file）；没有当前会话时为 null。 */
const activeFile = (page) => page.evaluate(() => document.querySelector('.session-item.active')?.dataset.file ?? null);

/** @brief 等会话文件是 file 的会话成为当前会话。 */
const waitActive = (page, file) => page.waitForFunction((f) => document.querySelector('.session-item.active')
  ?.dataset.file === f, file, { timeout: 10000 });

/** @brief 在左栏点会话文件是 file 的会话，等它成为当前会话并可以发送（没打开过的会先打开）。 */
async function openRow(ctx, file) {
  await rowOf(ctx.page, file).click();
  await waitActive(ctx.page, file);
  await waitReady(ctx.page);
}

/** @brief 点会话行，等它成为当前会话；返回先看到的是信任询问还是可以发送的会话（询问时选"Trust workspace"后等它可以发送）。 */
async function clickRow(ctx, file) {
  await rowOf(ctx.page, file).click();
  await waitActive(ctx.page, file);
  const seen = await dialogOrReady(ctx.page);
  if (seen === 'dialog') await trustOnce(ctx.page);
  return seen;
}

/** @brief 等会话树出现、会话列表读完（启动和界面重新加载之后）。 */
async function waitTreeLoaded(page) {
  await page.getByTestId('session-tree').waitFor({ state: 'attached', timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('.sidebar-note')?.textContent?.includes('Loading sessions'),
    null, { timeout: 30000 });
}

/** @brief 启动 Mori（同一个数据目录），等会话列表读完。 */
async function start(ctx) {
  ctx.app = await launch({ exePath, userData: ctx.userData });
  ctx.page = await ctx.app.firstWindow();
  ctx.h = pageHelpers(ctx.page);
  ctx.page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  await waitTreeLoaded(ctx.page);
}

/** @brief 重启：像负责人一样关掉窗口（Mori 有序退出），再用同一个数据目录启动。20 秒没退出时由测试关闭并记下。 */
async function restart(ctx) {
  const { app } = ctx;
  const exited = new Promise((done) => app.process().once('exit', () => done(true)));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => {});
  const closed = await Promise.race([exited, sleep(20000).then(() => false)]);
  ctx.restarts.total += 1;
  if (!closed) {
    ctx.restarts.forced += 1;
    console.error('[m3-real] Mori did not exit within 20 s after its window was closed; closing it from the test');
    await app.close().catch(() => {});
  }
  await start(ctx);
}

/** @brief 右键会话行 → Rename → 填名字 → Enter。返回菜单开着时的当前会话和改名框预先填的名字。 */
async function renameByMouse(ctx, file, name) {
  const { page } = ctx;
  await openMenu(page, file);
  const activeAtMenu = await activeFile(page);
  await pickMenu(page, 'Rename');
  const input = page.getByTestId('rename-input');
  await input.waitFor({ timeout: 5000 });
  const prefill = await input.inputValue();
  await input.fill(name);
  await input.press('Enter');
  await input.waitFor({ state: 'detached', timeout: 10000 });
  return { activeAtMenu, prefill };
}

// ---------- 走查 1：两个项目各两个会话 ----------

/** @brief 走查 1 的四个会话：两个文件夹各建两个（第二个按 Ctrl+N），各发一条消息并等它结束。已建过时直接返回。 */
async function makeSessions(ctx) {
  if (ctx.s.a1) return;
  for (const [key, folder] of [['a1', ctx.dirs.alpha], ['a2', null], ['b1', ctx.dirs.beta], ['b2', null]]) {
    if (folder) await openNew(ctx, folder);
    else await pressCtrlN(ctx);
    await waitReady(ctx.page);
    const file = await activeFile(ctx.page);
    await ctx.h.send(MESSAGES[key]);
    const cards = await settle(ctx);
    ctx.s[key] = { file, text: MESSAGES[key], cards: cards.map((card) => card.tool) };
  }
}

/** @brief 走查 1：侧栏按项目分组，会话名取第一条消息的前 20 个字；项目与会话的顺序；当前会话高亮。 */
async function item1(ctx) {
  await makeSessions(ctx);
  const { page } = ctx;
  const groups = await treeGroups(page);
  const alpha = groups.find((g) => samePath(g.cwd, ctx.dirs.alpha));
  const beta = groups.find((g) => samePath(g.cwd, ctx.dirs.beta));
  const titled = (group, keys) => Boolean(group) && group.rows.length === keys.length && keys.every((key) => {
    const row = group.rows.find((r) => r.file === ctx.s[key].file);
    return row?.label === expectedTitle(MESSAGES[key]) && row.full === MESSAGES[key];
  });
  const cards = Object.entries(ctx.s).filter(([, s]) => s.cards.length).map(([key, s]) => `${key}:${s.cards}`);
  record('1 侧栏按项目分组：两个项目各两个会话；会话名取第一条消息的前 20 个字加"…"，悬停显示全文',
    groups.length === 2 && titled(alpha, ['a1', 'a2']) && titled(beta, ['b1', 'b2']),
    `${groups.map((g) => `${g.name}: ${g.rows.map((r) => r.label).join(' / ')}`).join('；')}`
      + `${cards.length ? `；模型调用了工具（已拒绝）：${cards.join(' ')}` : ''}`);
  record('1 项目行显示文件夹名，悬停显示完整路径', alpha?.name === 'm3-alpha' && beta?.name === 'm3-beta'
    && samePath(alpha.path, ctx.dirs.alpha) && samePath(beta.path, ctx.dirs.beta),
  groups.map((g) => `${g.name} ← ${g.path}`).join('；'));
  const keyOf = (file) => Object.keys(ctx.s).find((key) => ctx.s[key].file === file) ?? '?';
  const order = groups.map((g) => g.rows.map((r) => keyOf(r.file)).join(',')).join(' | ');
  record('1 项目按其中最新的会话排（后建的 m3-beta 在上），会话在项目内从新到旧', order === 'b2,b1 | a2,a1', order);
  const active = groups.flatMap((g) => g.rows).filter((r) => r.active);
  const title = await topTitle(page);
  const paneName = await page.locator(`${P}[data-testid="chat-pane"]`).getAttribute('aria-label');
  record('1 当前会话高亮；顶栏会话名和会话面板的读屏名称与会话行同一规则', active.length === 1
    && active[0].file === ctx.s.b2.file && title === expectedTitle(MESSAGES.b2) && paneName === title,
  `高亮：${active.map((r) => r.label).join(',')}；顶栏：${title}；读屏名称：${paneName}`);
  await shot(page, '1-tree');
}

// ---------- 走查 2：只用键盘新建、改名 ----------

/** @brief 从当前焦点连按 Shift+Tab，直到焦点进入会话树（最多 max 次）；返回每次焦点落到的元素。 */
async function shiftTabToTree(page, max = 12) {
  const path = [];
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Shift+Tab');
    const info = await focusInfo(page);
    path.push(info.label);
    if (info.inTree) break;
  }
  return path;
}

/** @brief 走查 2：Ctrl+N 新建（焦点在输入框）→ Shift+Tab 回到会话树（落在新会话行）→ Shift+F10 → Enter → 输入 → Enter。 */
async function item2(ctx) {
  await makeSessions(ctx);
  const { page } = ctx;
  // 准备：当前会话在 m3-beta（之后只用键盘）。
  await openRow(ctx, ctx.s.b2.file);
  await ctx.h.textarea.focus();
  await pressCtrlN(ctx);
  await waitReady(page);
  const row = (await allRows(page)).find((r) => r.active);
  record('2 Ctrl+N：在当前会话所在的项目里新建"新会话"并切过去，焦点在它的输入框',
    row?.label === 'New session' && samePath(row.cwd, ctx.dirs.beta) && await composerFocused(page),
    JSON.stringify(row));
  if (!row?.file) throw new Error('the new session has no row');
  const path = await shiftTabToTree(page);
  const focused = await focusInfo(page);
  record('2 Shift+Tab 回到会话树时落在新会话行（整棵树一个 Tab 停靠点）', focused.row === row.id,
    `按了 ${path.length} 次 Shift+Tab：${path.join(' → ')}`);
  // M6 顶栏加了模型和思考强度两个按钮（models.md），多两个 Tab 停靠点：6 次改为 8 次。
  record('2 从新会话的输入框 Shift+Tab 几次（不超过 8 次，经过顶栏和左栏底部的按钮）回到会话树（sessions.md 走查 2 的路径）',
    path.length <= 8 && focused.row === row.id, `按了 ${path.length} 次：${path.join(' → ')}`);
  if (focused.row !== row.id) await rowOf(page, row.file).focus();
  await renameByKeyboard(ctx, row);
}

/** @brief 走查 2 后半：焦点在新会话行上，Shift+F10 → Enter（Rename）→ 输入 → Enter；再 Enter 进输入框发第一条消息。 */
async function renameByKeyboard(ctx, row) {
  const { page } = ctx;
  await page.keyboard.press('Shift+F10');
  await page.getByTestId('session-menu').waitFor({ timeout: 5000 });
  const menuFocus = await focusInfo(page);
  record('2 Shift+F10 打开右键菜单，焦点在"重命名"', menuFocus.role === 'menuitem' && menuFocus.label.startsWith('Rename'),
    menuFocus.label);
  await shot(page, '2-menu');
  await page.keyboard.press('Enter');
  const input = page.getByTestId('rename-input');
  await input.waitFor({ timeout: 5000 });
  const box = await input.evaluate((el) => ({ value: el.value, focused: document.activeElement === el }));
  record('2 Enter 选"重命名"：会话行变成输入框并获得焦点（新会话没有名字和消息，框里是空的）',
    box.focused && box.value === '', JSON.stringify(box));
  await page.keyboard.type(NAMES.keyboard);
  await shot(page, '2-rename');
  await page.keyboard.press('Enter');
  await input.waitFor({ state: 'detached', timeout: 10000 });
  await sleep(300);
  const renamed = await rowByFile(page, row.file);
  const focused = await focusInfo(page);
  const title = await topTitle(page);
  record('2 Enter 保存：侧栏和顶栏显示新名字，焦点回到这个会话行', renamed?.label === NAMES.keyboard
    && title === NAMES.keyboard && focused.row === row.id, `${renamed?.label}；顶栏：${title}；焦点：${focused.label}`);
  await page.keyboard.press('Enter');
  await sleep(300);
  record('2 在会话行上按 Enter：焦点进入它的输入框', await composerFocused(page), (await focusInfo(page)).label);
  await page.keyboard.type(B3_MESSAGE);
  await page.keyboard.press('Enter');
  await settle(ctx);
  const sent = await rowByFile(page, row.file);
  record('2 改名后再发第一条消息：会话名仍是改的名字，不换成第一条消息', sent?.label === NAMES.keyboard, sent?.label);
  ctx.s.b3 = { file: row.file, text: B3_MESSAGE, cards: [] };
}

// ---------- 走查 3：改名后重启 ----------

/** @brief 走查 3：右键改名打开中的会话 → 重启：名字和完整对话都在；再改名一个没打开的会话 → 重启：名字还在。 */
async function item3(ctx) {
  await makeSessions(ctx);
  const { a1 } = ctx.s;
  const activeBefore = await activeFile(ctx.page);
  const done = await renameByMouse(ctx, a1.file, NAMES.opened);
  record('3 右键菜单不切换当前会话；改名框预先填第一条消息的前 20 个字（不带"…"）',
    done.activeAtMenu === activeBefore && done.prefill === first20(a1.text), JSON.stringify(done));
  await openRow(ctx, a1.file);
  const label = (await rowByFile(ctx.page, a1.file))?.label;
  const title = await topTitle(ctx.page);
  record('3 打开中的会话改名：侧栏和顶栏都是新名字', label === NAMES.opened && title === NAMES.opened,
    `${label}；顶栏：${title}`);
  const before = await conversation(ctx.page);
  await shot(ctx.page, '3-renamed');
  await restart(ctx);
  await checkAfterRestart(ctx, before);
  await renameUnopened(ctx);
}

/** @brief 走查 3 重启之后：中栏、侧栏的名字、打开后的对话与重启前相同。 */
async function checkAfterRestart(ctx, before) {
  const { page } = ctx;
  const center = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="open-folder"]');
    if (!box) return null;
    return { heading: box.querySelector('h2')?.textContent, hint: box.querySelector('.muted')?.textContent };
  });
  record('3 重启后中栏"打开一个文件夹"，说明"从左侧选一个会话继续，或打开一个文件夹开始新的会话。"',
    center?.heading === 'Open a folder' && center.hint === PICK_HINT, JSON.stringify(center));
  const rows = await allRows(page);
  const labelOf = (key) => rows.find((r) => r.file === ctx.s[key]?.file)?.label;
  record('3 重启后改过的名字还在（右键改名的，和走查 2 用键盘改名的）', labelOf('a1') === NAMES.opened
    && (!ctx.s.b3 || labelOf('b3') === NAMES.keyboard), rows.map((r) => r.label).join(' / '));
  await openRow(ctx, ctx.s.a1.file);
  const after = await conversation(page);
  const title = await topTitle(page);
  record('3 重启后打开改过名的会话：顶栏是新名字，完整对话都在（你的消息和回复与重启前相同）', title === NAMES.opened
    && before.users.length > 0 && before.replies.length > 0 && JSON.stringify(after) === JSON.stringify(before),
  `顶栏：${title}；重启前 ${before.users.length} 条你的消息、${before.replies.length} 条回复；`
    + `重启后 ${after.users.length}、${after.replies.length}`);
  await shot(page, '3-reopened');
  if (!ctx.s.b3) return;
  await openRow(ctx, ctx.s.b3.file);
  const b3 = await conversation(page);
  const b3Title = await topTitle(page);
  record('3 走查 2 里先改名再发消息的会话，重启后名字和对话都在', b3Title === NAMES.keyboard
    && b3.users[0] === ctx.s.b3.text && b3.replies.length > 0, `顶栏：${b3Title}；${JSON.stringify(b3.users)}`);
}

/** @brief 走查 3：没打开的会话改名（写进会话文件、重新读取列表），重启后名字还在，打开后对话也在。 */
async function renameUnopened(ctx) {
  const { b1 } = ctx.s;
  const done = await renameByMouse(ctx, b1.file, NAMES.unopened);
  const shown = await waitLabel(ctx.page, b1.file, NAMES.unopened);
  record('3 没打开的会话改名：预先填第一条消息的前 20 个字，保存后侧栏显示新名字', done.prefill === first20(b1.text)
    && shown, JSON.stringify(done));
  await restart(ctx);
  const row = await rowByFile(ctx.page, b1.file);
  await openRow(ctx, b1.file);
  const conv = await conversation(ctx.page);
  const title = await topTitle(ctx.page);
  record('3 没打开时改的名字重启后还在；打开后顶栏是新名字、对话都在', row?.label === NAMES.unopened
    && title === NAMES.unopened && conv.users[0] === b1.text && conv.replies.length > 0,
  `${row?.label}；顶栏：${title}；${conv.users.length} 条你的消息、${conv.replies.length} 条回复`);
}

// ---------- 走查 4：归档与删除 ----------

/**
 * @brief 走查 4：正在生成不能归档、删除；归档当前会话、"Unarchive"、点已归档的会话恢复并打开；永久删除当前会话和还没有消息的
 *        会话；用键盘归档另一个会话，重启后它还在"Archived"里，再用键盘永久删除它；删除的文件没有进回收站；重启后不再出现。
 */
async function item4(ctx) {
  await makeSessions(ctx);
  await busyBlocked(ctx);
  await archiveCurrent(ctx);
  await restoreByMenu(ctx);
  await restoreByClick(ctx);
  await deleteCurrent(ctx);
  await deleteUnsaved(ctx);
  await archiveByKeyboard(ctx);
  await restart(ctx);
  await archivedAfterRestart(ctx);
  await deleteArchivedByKeyboard(ctx);
  checkNotRecycled([ctx.s.b2.file, ctx.s.a2.file]);
  await restart(ctx);
  await deletedAfterRestart(ctx);
}

/** @brief 正在生成的会话：右键菜单里"Archive""Delete…"不可用（小字"Still running"）；Esc 只关菜单、不停止生成。 */
async function busyBlocked(ctx) {
  const { page } = ctx;
  const { b2 } = ctx.s;
  await openRow(ctx, b2.file);
  await ctx.h.send(MEDIUM);
  await waitRowStatus(page, b2.file, ['running', 'approval'], 20000);
  await openMenu(page, b2.file);
  const texts = menuText(await menuItems(page));
  const status = (await rowByFile(page, b2.file))?.status;
  await shot(page, '4-generating-menu');
  record('4 正在生成的会话：右键菜单里"归档""删除"不可用，旁边小字"正在生成"；"重命名"可用',
    ['running', 'approval'].includes(status)
      && texts === 'Rename / ArchiveStill running（不可用） / Delete…Still running（不可用）', `${status}；${texts}`);
  await page.keyboard.press('Escape');
  await page.getByTestId('session-menu').waitFor({ state: 'detached', timeout: 5000 });
  await settle(ctx);
  const stopped = await page.locator(`${P}.notice.stopped`).count();
  record('4 菜单开着时按 Esc 只关菜单，不停止生成', stopped === 0 && (await lastReply(page)).length > 0,
    `"已停止"提示 ${stopped} 条`);
}

/**
 * @brief 右键归档当前会话（打开着、刚生成完、有草稿）：不确认；会话行移到"Archived 1"（默认收起）；中栏回到
 *        "Open a folder"；焦点移到原来排在它下面的会话行；会话文件和草稿都在。
 */
async function archiveCurrent(ctx) {
  const { page } = ctx;
  const { b2 } = ctx.s;
  await ctx.h.textarea.fill(ARCHIVE_DRAFT);
  await sleep(200);
  const next = await rowBelow(page, b2.file);
  await openMenu(page, b2.file);
  await pickMenu(page, 'Archive');
  const moved = await waitArchived(page, b2.file, true);
  await sleep(400);
  const dialogs = await page.locator('[data-testid="delete-dialog"], [data-testid="confirm-dialog"]').count();
  const focused = await focusInfo(page);
  const center = await centerHeading(page);
  const shelf = await archivedState(page);
  await shot(page, '4-archived');
  record('4 右键归档当前会话：不确认；会话行从项目下移到侧栏底部"已归档 1"（默认收起），本机的已归档列表记下它',
    moved && dialogs === 0 && shelf.toggle === 'Archived 1' && shelf.expanded === 'false' && shelf.rows === null,
    `移过去：${moved}；对话框 ${dialogs} 个；${JSON.stringify(shelf)}`);
  record('4 归档当前会话后：中栏回到"打开一个文件夹"，焦点移到原来排在它下面的会话行', center === 'Open a folder'
    && focused.row === next, `中栏：${center}；焦点：${focused.label}（${focused.row}，应为 ${next}）`);
  record('4 归档不删东西：会话文件还在，草稿保留', existsSync(b2.file) && await hasDraft(page, b2.file) === true,
    `文件还在：${existsSync(b2.file)}`);
}

/** @brief 展开"Archived"：列出归档的会话；它的右键菜单是"Unarchive""Delete…"；选"Unarchive"：回到项目下，不打开。 */
async function restoreByMenu(ctx) {
  const { page } = ctx;
  const { b2 } = ctx.s;
  await expandArchived(page);
  const listed = (await archivedState(page)).rows?.find((row) => row.file === b2.file);
  await shot(page, '4-archived-list');
  record('4 点"已归档 1"展开：列出归档的会话（会话名），悬停显示文件夹和完整名字',
    listed?.label === expectedTitle(b2.text) && listed.title.includes('m3-beta') && listed.title.includes(b2.text),
    JSON.stringify(listed ?? null));
  await openMenu(page, b2.file);
  const texts = menuText(await menuItems(page));
  await pickMenu(page, 'Unarchive');
  const restored = await waitArchived(page, b2.file, false);
  const row = await rowByFile(page, b2.file);
  const center = await centerHeading(page);
  const shelf = await archivedState(page);
  record('4 已归档的会话右键菜单是"恢复""删除"；选"恢复"：回到它的项目下，不打开（中栏不变），"已归档"没有了',
    texts === 'Unarchive / Delete…' && restored && samePath(row?.cwd, ctx.dirs.beta) && center === 'Open a folder'
      && shelf.toggle === null, `菜单：${texts}；项目：${row?.cwd}；中栏：${center}；已归档：${shelf.toggle}`);
}

/** @brief 再归档一次（这次它没打开），点"Archived"里的它：恢复并打开，对话和归档前的草稿都在。 */
async function restoreByClick(ctx) {
  const { page } = ctx;
  const { b2 } = ctx.s;
  await openMenu(page, b2.file);
  await pickMenu(page, 'Archive');
  const archived = await waitArchived(page, b2.file, true);
  await expandArchived(page);
  await rowOf(page, b2.file).click();
  await waitActive(page, b2.file);
  await waitReady(page);
  const row = await rowByFile(page, b2.file);
  const conv = await conversation(page);
  const draft = await ctx.h.textarea.inputValue();
  const stored = await storedArchived(page);
  await shot(page, '4-restored-open');
  record('4 再归档一次（没打开的会话），点"已归档"里的它：恢复并打开（回到项目下、成为当前会话），对话和草稿都在',
    archived && row?.active === true && Array.isArray(stored) && !stored.includes(b2.file)
      && conv.users.includes(MEDIUM) && conv.replies.length > 0 && draft === ARCHIVE_DRAFT,
    `再归档：${archived}；当前：${row?.active}；${conv.users.length} 条你的消息、${conv.replies.length} 条回复；`
      + `草稿：${draft}`);
}

/** @brief 删除对话框：文字、焦点在"Cancel"、Tab 只在两个按钮之间切换。 */
async function checkConfirm(page, dialog, title) {
  const text = await dialog.innerText();
  const first = (await focusInfo(page)).label;
  await page.keyboard.press('Tab');
  const second = (await focusInfo(page)).label;
  await page.keyboard.press('Tab');
  const third = (await focusInfo(page)).label;
  record('4 删除先确认："永久删除会话\'会话名\'？"、"对话记录会被删除，无法恢复。"，焦点在"取消"，'
    + 'Tab 只在"删除"和"取消"之间切换', text.includes(`Delete “${title}”?`)
    && text.includes('This session will be permanently deleted. This can’t be undone.') && first === 'Cancel'
    && second === 'Delete' && third === 'Cancel',
  `${oneLine(text)}；焦点：${first} → ${second} → ${third}`);
  await shot(page, '4-confirm');
}

/**
 * @brief 右键永久删除当前会话（恢复后打开着、有草稿）：先确认；确认后会话行消失、中栏回到"Open a folder"、
 *        焦点移到下一行；会话文件和草稿都删了。
 */
async function deleteCurrent(ctx) {
  const { page } = ctx;
  const { b2 } = ctx.s;
  const draftBefore = await hasDraft(page, b2.file);
  const next = await rowBelow(page, b2.file);
  const title = (await rowByFile(page, b2.file))?.label;
  await openMenu(page, b2.file);
  await pickMenu(page, 'Delete');
  const dialog = page.getByTestId('delete-dialog');
  await dialog.waitFor({ timeout: 5000 });
  await checkConfirm(page, dialog, title);
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 20000 });
  await sleep(400);
  const focused = await focusInfo(page);
  const center = await centerHeading(page);
  record('4 确认删除当前会话：会话行消失，中栏回到"打开一个文件夹"，焦点移到删除前排在它下面的会话行',
    !(await rowByFile(page, b2.file)) && center === 'Open a folder' && focused.row === next,
    `焦点：${focused.label}（${focused.row}，应为 ${next}）；中栏：${center}`);
  record('4 永久删除：会话文件不在了，草稿一起删除', !existsSync(b2.file) && draftBefore === true
    && await hasDraft(page, b2.file) === false, `删除前有草稿：${draftBefore}；文件还在：${existsSync(b2.file)}`);
  await shot(page, '4-deleted');
}

/** @brief 还没有消息的新会话：菜单里"Archive"不可用（小字"No messages yet"）；删除的说明是"This session has no messages yet."。 */
async function deleteUnsaved(ctx) {
  const { page } = ctx;
  // Ctrl+N 要有当前会话（没有时等于"Open folder…"）：先打开 a1。
  await openRow(ctx, ctx.s.a1.file);
  await ctx.h.textarea.focus();
  await pressCtrlN(ctx);
  await waitReady(page);
  const row = (await allRows(page)).find((r) => r.active);
  if (!row?.file) throw new Error('the new session has no row');
  await openMenu(page, row.file);
  const texts = menuText(await menuItems(page));
  await pickMenu(page, 'Delete');
  const dialog = page.getByTestId('delete-dialog');
  await dialog.waitFor({ timeout: 5000 });
  const text = await dialog.innerText();
  await shot(page, '4-unsaved-confirm');
  record('4 还没有消息的新会话：菜单里"归档"不可用、小字"还没有消息"，"删除"可用；删除确认的说明是"这个会话还没有消息。"',
    texts === 'Rename / ArchiveNo messages yet（不可用） / Delete…' && text.includes('Delete “New session”?')
      && text.includes('This session has no messages yet.'), `${texts}；${oneLine(text)}`);
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 20000 });
  await sleep(300);
  const center = await centerHeading(page);
  record('4 确认删除还没有消息的新会话：会话行消失，中栏回到"打开一个文件夹"', !(await rowByFile(page, row.file))
    && center === 'Open a folder', `中栏：${center}`);
}

/**
 * @brief 开着的菜单里从"Rename"按 ↓ 直到焦点在开头是 label 的菜单项上（最多 max 次）；返回按的次数和焦点所在菜单项的
 *        文字。走不到时抛错（不在别的菜单项上按 Enter）。
 */
async function arrowDownTo(page, label, max = 5) {
  for (let presses = 1; presses <= max; presses += 1) {
    await page.keyboard.press('ArrowDown');
    const item = (await focusInfo(page)).label;
    if (item.startsWith(label)) return { presses, item };
  }
  throw new Error(`menu item ${label} cannot be reached with ArrowDown`);
}

/**
 * @brief 只用键盘归档另一个会话：焦点在会话行上，Shift+F10 → ↓ 到"Archive" → Enter。M5 起"Rename"和"Archive"之间多了
 *        "Attach as context""Open in split view"（没有当前会话时前者不可用、↓ 跳过，后者可用），所以 ↓ 到"Archive"为止。
 */
async function archiveByKeyboard(ctx) {
  const { page } = ctx;
  const { a2 } = ctx.s;
  await rowOf(page, a2.file).focus();
  await page.keyboard.press('Shift+F10');
  const menu = page.getByTestId('session-menu');
  await menu.waitFor({ timeout: 5000 });
  const enabled = await menu.getByRole('menuitem').evaluateAll((items) => items.filter((item) => !item.disabled)
    .map((item) => item.childNodes[0]?.textContent ?? ''));
  const expected = enabled.indexOf('Archive');
  const { presses, item } = await arrowDownTo(page, 'Archive');
  await page.keyboard.press('Enter');
  const moved = await waitArchived(page, a2.file, true);
  const shelf = await archivedState(page);
  record('4 只用键盘归档（Shift+F10 → ↓ 到"Archive"→ Enter）：↓ 跳过不可用的菜单项，次数等于"Archive"前面可用的项数；'
    + '会话行移到"Archived 1"，会话文件还在', item.startsWith('Archive') && presses === expected
    && moved && shelf.toggle === 'Archived 1' && existsSync(a2.file),
  `↓ ${presses} 次（应为 ${expected}，可用的项：${enabled.join(' / ')}）；菜单焦点：${item}；已归档：${shelf.toggle}`);
}

/** @brief 重启后：删除的会话不在；归档的会话还在"Archived 1"里（默认收起、不在项目下）；其他会话还在。 */
async function archivedAfterRestart(ctx) {
  const { page } = ctx;
  const { a1, a2, b2 } = ctx.s;
  const rows = await allRows(page);
  const shelf = await archivedState(page);
  if (shelf.toggle !== null) await expandArchived(page);
  const listed = (await archivedState(page)).rows ?? [];
  await shot(page, '4-after-restart');
  record('4 重启后：删除的会话不再出现；归档的会话还在"已归档 1"里（默认收起、不在项目下）；其他会话还在',
    !rows.some((r) => r.file === b2.file || r.file === a2.file) && rows.some((r) => r.file === a1.file)
      && shelf.toggle === 'Archived 1' && shelf.expanded === 'false' && listed.some((r) => r.file === a2.file),
    `${rows.map((r) => r.label).join(' / ')}；已归档：${listed.map((r) => r.label).join(' / ')}`);
}

/** @brief 只用键盘永久删除已归档的会话：焦点在已归档的会话行上，Shift+F10（Unarchive、Delete…）→ ↓ → Enter → Tab → Enter。 */
async function deleteArchivedByKeyboard(ctx) {
  const { page } = ctx;
  const { a2 } = ctx.s;
  await expandArchived(page);
  const title = (await archivedState(page)).rows?.find((row) => row.file === a2.file)?.label;
  await rowOf(page, a2.file).focus();
  await page.keyboard.press('Shift+F10');
  await page.getByTestId('session-menu').waitFor({ timeout: 5000 });
  const texts = menuText(await menuItems(page));
  await page.keyboard.press('ArrowDown');
  const item = (await focusInfo(page)).label;
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('delete-dialog');
  await dialog.waitFor({ timeout: 5000 });
  const text = await dialog.innerText();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'detached', timeout: 20000 });
  await sleep(300);
  const left = await rowOf(page, a2.file).count();
  const shelf = await archivedState(page);
  const stored = await storedArchived(page);
  record('4 只用键盘删除已归档的会话（Shift+F10 → ↓ → Enter → Tab → Enter）：菜单是"恢复""删除"，'
    + '确认后会话行和"已归档"一起消失，会话文件不在了', texts === 'Unarchive / Delete…' && item.startsWith('Delete')
    && text.includes(`Delete “${title}”?`) && left === 0 && shelf.toggle === null && Array.isArray(stored)
    && !stored.includes(a2.file) && !existsSync(a2.file),
  `菜单：${texts}；菜单焦点：${item}；${oneLine(text)}；剩 ${left} 行；已归档：${shelf.toggle}`);
}

/** @brief 读系统回收站：名字、原位置、回收站里的路径。 */
function recycleBin() {
  const output = execFileSync('powershell', ['-NoProfile', '-Command', RECYCLE_SCRIPT],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, from, path] = line.split('|');
    return { name: name ?? '', from: from ?? '', path: path ?? '' };
  });
}

/** @brief 永久删除：删除的会话文件不在磁盘上，也不在系统回收站里（按原位置和文件名核对，扩展名可能被隐藏）。 */
function checkNotRecycled(files) {
  let items;
  try {
    items = recycleBin();
  } catch (error) {
    record('4 永久删除：删除的会话文件不在系统回收站里', false, `读不了回收站：${oneLine(error, 300)}`);
    return;
  }
  const inBin = (file) => items.some((item) => samePath(item.from, dirname(file))
    && [basename(file), basename(file, '.jsonl')].includes(item.name));
  const found = files.filter(inBin);
  const left = files.filter((file) => existsSync(file));
  record('4 永久删除：删除的会话文件不在磁盘上，也不在系统回收站里（PowerShell 读回收站，按原位置和文件名核对）',
    left.length === 0 && found.length === 0, `核对 ${files.length} 个文件；还在磁盘上：`
      + `${left.map((file) => basename(file)).join(', ') || '无'}；在回收站里：`
      + `${found.map((file) => basename(file)).join(', ') || '无'}`);
}

/** @brief 再重启：删除的会话都不再出现（项目下没有，也没有"Archived"），其他会话还在。 */
async function deletedAfterRestart(ctx) {
  const { page } = ctx;
  const { a1, a2, b2 } = ctx.s;
  const rows = await allRows(page);
  const shelf = await archivedState(page);
  record('4 再重启：两个删除的会话都不再出现（项目下没有，也没有"已归档"），其他会话还在',
    !rows.some((r) => r.file === a2.file || r.file === b2.file) && rows.some((r) => r.file === a1.file)
      && shelf.toggle === null, `${rows.map((r) => r.label).join(' / ')}；已归档：${shelf.toggle}`);
}

// ---------- 走查 5：项目信任 ----------

/** @brief 当前信任询问里的内容。 */
function trustDialogState(page) {
  return page.getByTestId('trust-dialog').evaluate((el) => ({ title: el.querySelector('h2')?.textContent ?? '',
    text: el.textContent, path: el.querySelector('[data-testid="trust-path"]')?.textContent ?? '',
    remember: el.querySelector('input[type=checkbox]')?.checked ?? null,
    focused: document.activeElement?.textContent?.trim() ?? '' }));
}

/**
 * @brief 走查 5：先问；不信任 → 工具里没有 project_hello；重启又问；信任 + 记住 → 能调用；重启不再问；
 *        重新打开不信任时保存的会话 → 现在也能调用（打开时刷新工具）。
 */
async function item5(ctx) {
  await trustDeny(ctx);
  await untrustedTools(ctx);
  await restart(ctx);
  await trustAllow(ctx);
  await restart(ctx);
  await trustRemembered(ctx);
  await reopenUntrusted(ctx);
}

/** @brief 打开带扩展的文件夹：先弹询问（回答之前扩展不运行）；选"Don’t trust"：横幅，扩展不运行。记下这个会话。 */
async function trustDeny(ctx) {
  const { page } = ctx;
  const marker = ctx.dirs.markers.ext;
  const seen = await openAndSee(ctx, ctx.dirs.ext);
  if (seen !== 'dialog') throw new Error('no trust dialog for a folder with .pi/extensions');
  const state = await trustDialogState(page);
  record('5 打开带 .pi/extensions 的文件夹：先弹"信任这个文件夹？"（说明、完整路径、"记住"默认不勾），焦点在"不信任"',
    state.title === 'Trust this workspace?' && state.text.includes(TRUST_TEXT) && samePath(state.path, ctx.dirs.ext)
      && state.remember === false && state.focused === 'Don’t trust', JSON.stringify(state));
  const waiting = await notReadyText(page);
  const slots = await page.locator('.pane-slot').count();
  await page.keyboard.press('Control+N');
  await sleep(1500);
  record('5 询问时中栏已切到这个会话（"正在启动…"）；询问开着时 Ctrl+N 不起作用', waiting === 'Starting…'
    && await page.locator('.pane-slot').count() === slots && await page.getByTestId('trust-dialog').isVisible(),
  `输入框位置：${waiting}`);
  record('反例：回答之前项目扩展没有运行（标记文件不存在）', !existsSync(marker));
  await shot(page, '5-trust-dialog');
  await page.getByTestId('trust-dialog').getByRole('button', { name: 'Don’t trust', exact: true }).click();
  await page.getByTestId('trust-dialog').waitFor({ state: 'detached', timeout: 5000 });
  await waitReady(page);
  await sleep(300);
  ctx.untrusted = await activeFile(page);
  const banner = await bannerText(page);
  record('5 选"不信任"：横幅说明没有加载、重启后会再问；焦点进这个会话的输入框', banner === UNTRUSTED
    && await composerFocused(page), banner);
  record('反例：选"不信任"后项目扩展没有运行（标记文件不存在）', !existsSync(marker));
}

/** @brief 不信任时：问模型能用哪些工具，回答里没有 project_hello；让它调用，不出批准卡。 */
async function untrustedTools(ctx) {
  const { page } = ctx;
  await ctx.h.send(LIST_TOOLS);
  await settle(ctx);
  const listed = await lastReply(page);
  record('5 不信任时问模型能用哪些工具：回答里没有 project_hello', !listed.toLowerCase().includes(HELLO_TOOL)
    && BUILTIN_TOOLS.some((tool) => listed.includes(tool)), oneLine(listed, 300));
  await ctx.h.send(CALL_HELLO);
  const cards = await settle(ctx);
  const tools = await toolCards(page);
  const reply = await lastReply(page);
  record('5 不信任时让模型调用 project_hello：不出它的批准卡（模型的回复见说明）',
    !cards.some((card) => card.tool === HELLO_TOOL), `卡：${JSON.stringify(cards)}；工具卡：${JSON.stringify(tools)}；`
      + `回复：${oneLine(reply, 200)}`);
  await shot(page, '5-untrusted');
}

/** @brief 重启后再打开：又问；勾"Remember my choice"、选"Trust workspace"：扩展加载；让模型调用 project_hello，Alt+1 允许。 */
async function trustAllow(ctx) {
  const { page } = ctx;
  const marker = ctx.dirs.markers.ext;
  const seen = await openAndSee(ctx, ctx.dirs.ext);
  record('5 没勾"记住"：重启后再打开这个文件夹又问', seen === 'dialog', seen);
  if (seen !== 'dialog') return;
  record('反例：重启后再次询问、回答之前项目扩展仍没有运行', !existsSync(marker));
  const dialog = page.getByTestId('trust-dialog');
  await dialog.getByRole('checkbox', { name: 'Remember my choice' }).check();
  await dialog.getByRole('button', { name: 'Trust workspace', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  await waitReady(page);
  const banner = await bannerText(page);
  record('5 勾"记住"、选"信任"：没有横幅，项目扩展加载了（标记文件出现，作为反例的对照）',
    banner === null && existsSync(marker), `横幅：${banner}`);
  await callHello(ctx, '5 信任后让模型调用 project_hello', CALL_HELLO, '5-hello');
  const trustFile = join(ctx.userData, 'pi', 'trust.json');
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(trustFile, 'utf8'));
  } catch (error) {
    console.error(`[m3-real] cannot read ${trustFile}: ${error.message}`);
  }
  record('5 勾了"记住"：选择写进了 pi 的 trust.json', Object.entries(saved)
    .some(([path, trusted]) => trusted === true && samePath(path, ctx.dirs.ext)), JSON.stringify(saved));
}

/**
 * @brief 让模型调用 project_hello：出批准卡，标题是工具原名；Alt+1 允许；工具卡完成，回复里有它返回的文字。
 * @param label 检查项名字的开头；message 发给模型的话；name 截图名的开头
 */
async function callHello(ctx, label, message, name, known = false) {
  const { page } = ctx;
  await ctx.h.send(message);
  await waitRunning(page);
  const card = await nextCard(page);
  const title = card?.kind === 'approval'
    ? (await cardOf(page, card).getByTestId('approval-title').innerText()).trim() : null;
  record(`${label}：出批准卡，标题为工具原名`, card?.tool === HELLO_TOOL && title === HELLO_TOOL,
    card ? `${card.kind} ${card.tool ?? card.method}：${title}`
      : `没有批准卡；回复：${oneLine(await lastReply(page), 200)}`, known);
  if (!card) return;
  await shot(page, `${name}-card`);
  const decide = (next) => (next.kind === 'approval' && next.tool === HELLO_TOOL
    ? altKey(ctx, 1) : rejectCard(ctx, next));
  await decide(card);
  await cardOf(page, card).waitFor({ state: 'detached', timeout: 15000 });
  await answerCards(page, decide, [card.key]);
  await waitIdle(page);
  const tools = await toolCards(page);
  const reply = await lastReply(page);
  record(`${label}：Alt+1 允许后 project_hello 的工具卡完成，回复里提到它返回的 hello from project`,
    tools.some((tool) => tool.title.includes(HELLO_TOOL) && tool.status === 'done')
      && reply.toLowerCase().includes(HELLO_TEXT), `${JSON.stringify(tools)}；回复：${oneLine(reply, 200)}`, known);
  await shot(page, `${name}-done`);
}

/** @brief 勾"Remember my choice"后重启：再打开这个文件夹不再问，直接信任（扩展照常加载）。 */
async function trustRemembered(ctx) {
  const { page } = ctx;
  const marker = ctx.dirs.markers.ext;
  rmSync(marker, { force: true });
  await watchTrustDialog(page);
  const seen = await openAndSee(ctx, ctx.dirs.ext);
  const flashed = await trustDialogSeen(page);
  if (seen === 'dialog') {
    await page.getByTestId('trust-dialog').getByRole('button', { name: 'Don’t trust', exact: true }).click();
    await waitReady(page);
  }
  const banner = await bannerText(page);
  record('5 勾"记住"后重启：再打开这个文件夹不再询问，直接信任（没有横幅，扩展照常加载）',
    seen === 'ready' && !flashed && banner === null && existsSync(marker),
    `先看到：${seen}；出现过询问：${flashed}；横幅：${banner}`);
  await shot(page, '5-remembered');
}

/** @brief 会话文件里把工具 name 声明给模型的系统消息（pi 在请求前写下的 toolsAdded 里有它）的条数。 */
function declaredCount(file, name) {
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.message?.role === 'system'
      && entry.message.toolsAdded?.some((tool) => tool.name === name)).length;
}

/**
 * @brief 重新打开不信任时保存的会话：不再问、没有横幅；打开时补上了工具，下一次请求前 pi 把 project_hello 声明给模型
 *        （会话文件里有记录）。模型在这个会话里先前说过没有这个工具，它之后列不列、调不调用是模型的行为：
 *        DeepSeek 两次都坚持原来的回答，这两项失败时记为 KNOWN；合成端点测试（m3-app）核对了请求里确有这个工具。
 */
async function reopenUntrusted(ctx) {
  const { page } = ctx;
  const file = ctx.untrusted;
  if (!file) throw new Error('no session was saved while the folder was untrusted');
  await watchTrustDialog(page);
  const seen = await clickRow(ctx, file);
  const banner = await bannerText(page);
  record('5 信任并记住之后重新打开不信任时保存的会话：不再询问，没有横幅', seen === 'ready'
    && !(await trustDialogSeen(page)) && banner === null, `先看到：${seen}；横幅：${banner}`);
  const { tools } = await page.evaluate((sessionFile) => window.mori.request({ type: 'session.open', sessionFile }),
    file);
  record('5 重新打开不信任时保存的会话：后台进程里这个会话启用的工具有 project_hello（打开时补上现在注册了的扩展工具）',
    tools.includes(HELLO_TOOL), tools.join(', '));
  await ctx.h.send(LIST_TOOLS);
  await settle(ctx);
  const listed = await lastReply(page);
  const declared = declaredCount(file, HELLO_TOOL);
  record('5 重新打开不信任时保存的会话：下一次请求前 pi 把 project_hello 声明给了模型（会话文件里的系统消息 toolsAdded 有它）',
    declared > 0, `${declared} 条`);
  record('5 重新打开不信任时保存的会话：问模型能用哪些工具，回答里有 project_hello（模型行为）', listed.toLowerCase()
    .includes(HELLO_TOOL), oneLine(listed, 300), true);
  await callHello(ctx, '5 在不信任时保存的会话里（信任后重新打开）让模型调用 project_hello（模型行为）',
    CALL_HELLO_AGAIN, '5-reopened-hello', true);
}

// ---------- 走查 6：草稿 ----------

/** @brief 走查 6：在 A 写半句话，切到 B 再回 A，草稿还在；去设置页再回来还在；重启后也在。 */
async function item6(ctx) {
  await makeSessions(ctx);
  const { a1, b1 } = ctx.s;
  await openRow(ctx, a1.file);
  await ctx.h.textarea.click();
  await ctx.page.keyboard.type(DRAFTS.a);
  await openRow(ctx, b1.file);
  const bBefore = await ctx.h.textarea.inputValue();
  await ctx.h.textarea.click();
  await ctx.page.keyboard.type(DRAFTS.b);
  await openRow(ctx, a1.file);
  const aBack = await ctx.h.textarea.inputValue();
  record('6 在 A 写半句话，切到 B 再回 A：A 的草稿还在，B 的输入框里没有 A 的字', aBack === DRAFTS.a
    && !bBefore.includes(DRAFTS.a), `A：${aBack}；切到 B 时 B 的输入框：${bBefore}`);
  await ctx.page.getByRole('button', { name: 'Settings', exact: true }).click();
  await ctx.page.getByTestId('settings-page').waitFor({ timeout: 5000 });
  await ctx.page.getByRole('button', { name: 'Back to app' }).click();
  await waitReady(ctx.page);
  const aSettings = await ctx.h.textarea.inputValue();
  record('6 去设置页再回来：草稿还在', aSettings === DRAFTS.a, aSettings);
  await shot(ctx.page, '6-draft');
  await restart(ctx);
  await openRow(ctx, a1.file);
  const aRestart = await ctx.h.textarea.inputValue();
  await openRow(ctx, b1.file);
  const bRestart = await ctx.h.textarea.inputValue();
  record('6 重启后打开这两个会话：各自的草稿都在', aRestart === DRAFTS.a && bRestart === DRAFTS.b,
    `A：${aRestart}；B：${bRestart}`);
  await shot(ctx.page, '6-after-restart');
  // 清掉两个草稿，走查 7 从空的输入框开始。
  await ctx.h.textarea.fill('');
  await openRow(ctx, a1.file);
  await ctx.h.textarea.fill('');
}

// ---------- 走查 7：有新结果 ----------

/** @brief 走查 7：在一个会话开始较长的回答，切到另一个：侧栏"Running"→"Unread"；点开后消失。 */
async function item7(ctx) {
  await makeSessions(ctx);
  const { page } = ctx;
  const { a1, b1 } = ctx.s;
  await openRow(ctx, b1.file);
  await ctx.h.send(LONG);
  await waitRowStatus(page, b1.file, ['running'], 20000);
  await openRow(ctx, a1.file);
  const during = await rowByFile(page, b1.file);
  await shot(page, '7-running');
  record('7 切到别的会话：还在生成的会话行显示"生成中"', during?.status === 'running' && during.statusText === 'Running',
    JSON.stringify({ status: during?.status, text: during?.statusText }));
  await waitRowStatus(page, b1.file, ['unseen', 'error', 'approval'], 240000);
  const done = await rowByFile(page, b1.file);
  const other = await rowByFile(page, a1.file);
  await shot(page, '7-unseen');
  record('7 不可见的会话生成完成：侧栏显示"有新结果"（当前会话没有状态）', done?.status === 'unseen'
    && done.statusText === 'Unread' && other?.status === null,
  JSON.stringify({ hidden: done?.statusText, current: other?.statusText }));
  await rowOf(page, b1.file).click();
  await waitActive(page, b1.file);
  await sleep(300);
  const after = await rowByFile(page, b1.file);
  // 模型没听话、调用了工具时卡在批准上：拒绝后等它结束，再读回复。
  if (await running(page) === 'true') await settle(ctx);
  const reply = await lastReply(page);
  record('7 点开后"有新结果"消失，回复在对话流里', after?.status === null && reply.length > 0,
    `状态：${after?.statusText}；回复 ${reply.length} 字`);
}

// ---------- 走查 e：扩展的询问 ----------

/** @brief 走查 e：信任带 project_ask 的文件夹（不记住）；让模型调用它：Alt+1 允许，依次回答三张询问卡；看通知和回复。 */
async function itemE(ctx) {
  const { page } = ctx;
  const seen = await openAndSee(ctx, ctx.dirs.ask);
  if (seen !== 'dialog') throw new Error('no trust dialog for a folder with .pi/extensions');
  await trustOnce(page);
  const file = await activeFile(page);
  await ctx.h.send(CALL_ASK);
  const run = await askRun(ctx, file);
  checkQuestions(run.questions);
  await checkAskResult(ctx, run);
}

/** @brief 一张询问卡上看得到的内容（文字、按钮、输入框的提示），以及这时的阶段行、会话行状态、焦点是否还在输入框。 */
function questionState(page, card, file) {
  return page.evaluate(({ p, id, f }) => {
    const box = [...document.querySelectorAll(`${p}[data-testid="ext-ui-card"]`)]
      .find((el) => el.dataset.request === id);
    const row = [...document.querySelectorAll('.session-item')].find((el) => el.dataset.file === f);
    const status = row?.querySelector('[data-testid="session-status"]');
    return { method: box?.dataset.method ?? null, text: box?.innerText ?? '',
      buttons: [...(box?.querySelectorAll('button') ?? [])].map((button) => button.textContent.trim()),
      placeholder: box?.querySelector('input')?.getAttribute('placeholder') ?? null,
      stage: document.querySelector(`${p}[data-testid="stage"]`)?.textContent.trim() ?? null,
      status: status?.dataset.status ?? null, statusText: status?.textContent ?? '',
      composer: document.activeElement === document.querySelector(`${p}.composer textarea`) };
  }, { p: P, id: card.request, f: file });
}

/** @brief 回答一张询问卡：确认点"Yes"，选择点 green，输入框里写 pinecone 后按 Enter；别的种类点"Cancel"。 */
async function answerAsk(page, card) {
  const box = cardOf(page, card);
  if (card.method === 'confirm') return box.getByRole('button', { name: 'Yes', exact: true }).click();
  if (card.method === 'select') return box.getByRole('button', { name: ASK.select.answer, exact: true }).click();
  if (card.method !== 'input') return box.getByRole('button', { name: 'Cancel', exact: true }).click();
  await box.locator('input').fill(ASK.input.answer);
  await box.locator('input').press('Enter');
}

/** @brief 本轮里出现的卡：project_ask 的批准卡 Alt+1（别的工具 Alt+3）；询问卡第一次出现时记下样子、截图，再作答。 */
async function askRun(ctx, file) {
  const { page } = ctx;
  const run = { approvals: [], order: [], questions: {} };
  const known = [];
  await waitRunning(page);
  for (let card = await nextCard(page, known); card; card = await nextCard(page, known)) {
    known.push(card.key);
    if (card.kind === 'approval') {
      run.approvals.push(card.tool);
      await altKey(ctx, card.tool === ASK_TOOL ? 1 : 3);
    } else {
      run.order.push(card.method);
      if (!run.questions[card.method]) {
        run.questions[card.method] = await questionState(page, card, file);
        await shot(page, `e-${card.method}`);
      }
      await answerAsk(page, card);
    }
    await cardOf(page, card).waitFor({ state: 'detached', timeout: 15000 });
  }
  await waitIdle(page);
  return run;
}

/** @brief 三张询问卡的样子（extension-ui.md"询问卡"），以及有询问时的阶段行、会话行状态和焦点。 */
function checkQuestions({ confirm, select, input }) {
  const head = (state) => Boolean(state) && state.text.includes('An extension needs your input');
  record('e 确认：询问卡头"扩展的询问"，标题、说明原文，按钮"是""否"', head(confirm)
    && confirm.text.includes(ASK.confirm.title) && confirm.text.includes(ASK.confirm.message)
    && confirm.buttons.join(',') === 'Yes,No', JSON.stringify(confirm ?? null));
  record('e 有挂起的询问时：阶段行"等你回答"，会话行状态"等你回答"；询问卡不抢输入框的焦点',
    confirm?.stage === 'Waiting for your answer' && confirm.status === 'question'
      && confirm.statusText === 'Needs input' && confirm.composer === true,
    JSON.stringify(confirm ? { stage: confirm.stage, status: confirm.statusText, composer: confirm.composer } : null));
  record('e 选择：询问卡头"扩展的询问"、标题，每个选项一个按钮，加"取消"', head(select)
    && select.text.includes(ASK.select.title)
    && select.buttons.join(',') === [...ASK.select.options, 'Cancel'].join(','), JSON.stringify(select ?? null));
  record('e 输入：询问卡头"扩展的询问"、标题，输入框显示提示文字，"确定""取消"；带超时时一行"N 秒后自动取消"',
    head(input) && input.text.includes(ASK.input.title) && input.placeholder === ASK.input.placeholder
      && input.buttons.join(',') === 'Submit,Cancel' && /This request expires in \d+ seconds?/.test(input.text),
    JSON.stringify(input ?? null));
}

/** @brief 通知是对话流里一行"Extension: <原文>"（warning）；project_ask 的工具卡完成；模型的回复提到选的颜色和写的词。 */
async function checkAskResult(ctx, run) {
  const { page } = ctx;
  const notes = await page.locator(`${P}[data-testid="ext-notify"]`).evaluateAll((els) => els.map((el) => ({
    text: el.textContent, className: el.className })));
  record('e 扩展的通知：对话流里一行"扩展：原文"，warning 级别用警示样式（class warning）',
    notes.some((note) => note.text === `Extension: ${ASK.note}` && note.className.split(/\s+/).includes('warning')),
    JSON.stringify(notes));
  const tools = await toolCards(page);
  const reply = await lastReply(page);
  record('e 模型调用了 project_ask（Alt+1 允许）；确认、选择、输入三张询问卡依次出现，作答后工具卡完成',
    run.approvals.includes(ASK_TOOL) && run.order.slice(0, 3).join(',') === 'confirm,select,input'
      && tools.some((tool) => tool.title.includes(ASK_TOOL) && tool.status === 'done'),
    `批准卡：${run.approvals.join(',')}；询问：${run.order.join(',')}；工具卡：${JSON.stringify(tools)}`);
  record('e 模型的回复提到了作答的结果（选的颜色 green 和写的词 pinecone）',
    reply.toLowerCase().includes(ASK.select.answer) && reply.toLowerCase().includes(ASK.input.answer),
    oneLine(reply, 300));
  await shot(page, 'e-done');
}

// ---------- 走查 r：界面重新加载 ----------

/**
 * @brief 走查 r：在要问信任的文件夹里（信任、不记住）开始较长的回答，界面重新加载：侧栏"Running"；点它不问信任、
 *        接上后接着流完，草稿还在；再重新加载一次点开，对话相同；新建会话时信任询问又出现（本次的回答已清空）。
 */
async function itemR(ctx) {
  const { page } = ctx;
  const file = await startLongReply(ctx);
  const before = await lastReply(page);
  await page.reload();
  await waitTreeLoaded(page);
  await checkReloaded(ctx, file);
  const attached = await attachAfterReload(ctx, file, before);
  const final = await finishAttached(ctx, file, attached);
  await reloadAgain(ctx, file, final);
  await asksAgainAfterReload(ctx);
}

/** @brief 打开 m3-reload（信任、不记住），发较长的问题，写下草稿，等回复开始流出；返回会话文件。 */
async function startLongReply(ctx) {
  const { page } = ctx;
  const seen = await openAndSee(ctx, ctx.dirs.reload);
  if (seen !== 'dialog') throw new Error('no trust dialog for a folder with .pi/settings.json');
  await trustOnce(page);
  const file = await activeFile(page);
  await ctx.h.send(RELOAD_LONG);
  await waitRowStatus(page, file, ['running', 'approval'], 20000);
  await ctx.h.textarea.fill(RELOAD_DRAFT);
  // 等回复流出一些字（先思考的模型要多等一会儿），重新加载时它正在生成。
  await page.waitForFunction((p) => [...document.querySelectorAll(`${p}[data-testid="assistant"] .prose`)]
    .some((el) => el.textContent.trim().length >= 20), P, { timeout: 60000 }).catch(() => {});
  await shot(page, 'r-before-reload');
  return file;
}

/** @brief 重新加载后：中栏回到"Open a folder"；还在后台进程里生成的会话行显示"Running"。 */
async function checkReloaded(ctx, file) {
  const { page } = ctx;
  await waitRowStatus(page, file, ['running'], 10000).catch(() => {});
  const row = await rowByFile(page, file);
  const center = await centerHeading(page);
  await shot(page, 'r-reloaded');
  record('r 界面重新加载（page.reload，与 Ctrl+R 相同）后：中栏回到"打开一个文件夹"，'
    + '还在后台进程里生成的会话行显示"生成中"', row?.status === 'running' && row.statusText === 'Running'
    && center === 'Open a folder', `状态：${row ? row.statusText || '(没有)' : '(没有这一行)'}；中栏：${center}`);
}

/** @brief 点还在生成的会话：不问信任，直接接上；重新加载前流出的开头还在，之后的字接着流入。返回接上时的回复。 */
async function attachAfterReload(ctx, file, before) {
  const { page } = ctx;
  await watchTrustDialog(page);
  const seen = await clickRow(ctx, file);
  const state = await running(page);
  const reply = await lastReply(page);
  const prefix = chars(before).slice(0, 10).join('');
  const grew = await waitReplyLonger(page, chars(reply).length);
  await shot(page, 'r-attached');
  record('r 点这个会话：不问信任，直接接上；正在生成的回复接着显示（重新加载前流出的开头还在），之后的字接着流入',
    seen === 'ready' && !(await trustDialogSeen(page)) && state === 'true' && chars(reply).join('').includes(prefix)
      && grew, `先看到：${seen}；重新加载前 ${chars(before).length} 字，接上时 ${chars(reply).length} 字；`
      + `生成中：${state}；接着流入：${grew}`);
  return reply;
}

/** @brief 等接上的回复流完：本轮结束、没有错误卡、回复比接上时长、会话行没有状态；草稿还在。返回这时的对话。 */
async function finishAttached(ctx, file, attached) {
  const { page } = ctx;
  await settle(ctx);
  const conv = await conversation(page);
  const errors = await page.locator(`${P}[data-testid="error-card"]`).count();
  const row = await rowByFile(page, file);
  const reply = conv.replies.at(-1) ?? '';
  await shot(page, 'r-finished');
  record('r 接上的回复照常流完：本轮结束，没有错误，回复比接上时长；会话行不再显示"生成中"',
    errors === 0 && conv.users[0] === RELOAD_LONG && chars(reply).length > chars(attached).length
      && row?.status === null, `接上时 ${chars(attached).length} 字，流完 ${chars(reply).length} 字；`
      + `错误卡 ${errors} 张；状态：${row?.statusText || '(没有)'}`);
  const draft = await ctx.h.textarea.inputValue();
  record('r 重新加载前写在这个会话里的草稿还在（存在本机）', draft === RELOAD_DRAFT, draft);
  return conv;
}

/** @brief 再重新加载一次，点开这个会话（还在后台进程里、已空闲）：不问信任；对话与接上后流完的相同（没有丢字）。 */
async function reloadAgain(ctx, file, final) {
  const { page } = ctx;
  await page.reload();
  await waitTreeLoaded(page);
  const row = await rowByFile(page, file);
  await watchTrustDialog(page);
  const seen = await clickRow(ctx, file);
  const after = await conversation(page);
  const sizes = (conv) => conv.replies.map((reply) => chars(reply).length).join(',');
  record('r 再重新加载一次后点开：会话行没有状态，不问信任；对话与接上后流完的相同（从会话记录重建，没有丢字）',
    row?.status === null && seen === 'ready' && !(await trustDialogSeen(page))
      && JSON.stringify(after) === JSON.stringify(final),
    `状态：${row?.statusText || '(没有)'}；先看到：${seen}；重建后回复 ${sizes(after)} 字，流完时 ${sizes(final)} 字`);
}

/** @brief 重新加载清空了本次运行里信任询问的回答：在这个文件夹里新建会话（Ctrl+N）又问。 */
async function asksAgainAfterReload(ctx) {
  const { page } = ctx;
  await ctx.h.textarea.focus();
  await pressCtrlN(ctx);
  const seen = await dialogOrReady(page);
  if (seen === 'dialog') {
    await shot(page, 'r-asks-again');
    await trustOnce(page);
  }
  record('r 界面重新加载后本次运行里信任询问的回答清空：在这个文件夹里新建会话（Ctrl+N）又问', seen === 'dialog', seen);
}

// ---------- 反例 ----------

/** @brief 反例：询问开着时扩展不运行，Esc 等于"Don’t trust"；本次运行里同一文件夹不再问；问过之后才出现 .pi/。 */
async function counterExample(ctx) {
  await escDeny(ctx);
  await sameFolderAgain(ctx);
  await lateExtension(ctx);
}

/** @brief 询问开着 3 秒，扩展不运行；按 Esc：按"Don’t trust"打开，扩展仍不运行。 */
async function escDeny(ctx) {
  const { page } = ctx;
  const marker = ctx.dirs.markers.ext2;
  const seen = await openAndSee(ctx, ctx.dirs.ext2);
  if (seen !== 'dialog') throw new Error('no trust dialog for a folder with .pi/extensions');
  await sleep(3000);
  const during = existsSync(marker);
  await page.keyboard.press('Escape');
  await page.getByTestId('trust-dialog').waitFor({ state: 'detached', timeout: 5000 });
  await waitReady(page);
  const banner = await bannerText(page);
  record('反例：询问开着 3 秒项目扩展也没有运行；按 Esc 等于"不信任"，扩展仍没有运行',
    !during && !existsSync(marker) && banner === UNTRUSTED, `横幅：${banner}`);
  await shot(page, 'c-esc');
}

/** @brief 本次运行里在同一文件夹再新建会话（Ctrl+N）：不再问，沿用"Don’t trust"。 */
async function sameFolderAgain(ctx) {
  const { page } = ctx;
  await watchTrustDialog(page);
  await ctx.h.textarea.focus();
  await pressCtrlN(ctx);
  const seen = await dialogOrReady(page);
  if (seen === 'dialog') await page.keyboard.press('Escape');
  await waitReady(page);
  const banner = await bannerText(page);
  record('反例：本次运行里在同一文件夹再新建会话：不再问，沿用"不信任"，扩展没有运行', seen === 'ready'
    && !(await trustDialogSeen(page)) && banner === UNTRUSTED && !existsSync(ctx.dirs.markers.ext2),
  `先看到：${seen}；横幅：${banner}`);
}

/** @brief 没有 .pi 的文件夹不问；之后文件夹里才出现 .pi/extensions：再新建会话时先问，回答之前和不信任后都不运行。 */
async function lateExtension(ctx) {
  const { page } = ctx;
  const marker = ctx.dirs.markers.late;
  await watchTrustDialog(page);
  const first = await openAndSee(ctx, ctx.dirs.late);
  if (first === 'dialog') await page.keyboard.press('Escape');
  await waitReady(page);
  const plainBanner = await bannerText(page);
  record('反例：没有 .pi 的文件夹直接打开，不问、没有横幅', first === 'ready' && !(await trustDialogSeen(page))
    && plainBanner === null, `先看到：${first}；横幅：${plainBanner}`);
  writeExtension(ctx.dirs.late, marker);
  await ctx.h.textarea.focus();
  await pressCtrlN(ctx);
  const seen = await dialogOrReady(page);
  const during = existsSync(marker);
  if (seen === 'dialog') {
    await shot(page, 'c-late-dialog');
    await page.getByTestId('trust-dialog').getByRole('button', { name: 'Don’t trust', exact: true }).click();
  }
  await waitReady(page);
  const banner = await bannerText(page);
  record('反例：文件夹里后来才有 .pi/extensions：再新建会话时先问；回答之前和选"不信任"后扩展都没有运行',
    seen === 'dialog' && !during && !existsSync(marker) && banner === UNTRUSTED, `先看到：${seen}；横幅：${banner}`);
}

// ---------- 执行 ----------

/** 开着时要先关掉的浮层 */
const OVERLAYS = ['session-menu', 'delete-dialog', 'trust-dialog', 'rename-input', 'confirm-dialog', 'issue-dialog',
  'permission-menu'].map((id) => `[data-testid="${id}"]`).join(', ');

/** @brief 一项出错后收拾界面：关掉浮层（Esc），当前会话还在生成时等它结束（批准卡拒绝、询问卡取消）。 */
async function recover(ctx) {
  for (let i = 0; i < 3 && await ctx.page.locator(OVERLAYS).count() > 0; i += 1) {
    await ctx.page.keyboard.press('Escape');
    await sleep(300);
  }
  if (await running(ctx.page) === 'true') await settle(ctx);
}

/** @brief 依次执行一项走查；出错时记录并截图，收拾界面后继续下一项。 */
async function step(ctx, name, fn) {
  try {
    return await fn();
  } catch (error) {
    record(`${name}：流程`, false, oneLine(error, 400));
    await shot(ctx.page, `${name}-error`);
    await recover(ctx).catch((cause) => console.error(`[m3-real] recover after ${name} failed: ${cause}`));
    return undefined;
  }
}

/**
 * @brief 走查数据目录里要有 Mori（v1）保存的提供商（只读 model-config.json 的非机密部分，lib.mjs realProviders，
 *        规格 §14.4）；没有时在复制密文之前就失败。
 */
function requireConnection(dir) {
  realProviders(dir);
}

requireConnection(source);
const root = mkdtempSync(join(tmpdir(), 'mori-m3-real-'));
// s：走查 1–2 建的会话；untrusted：走查 5 里不信任时保存的会话文件。
const ctx = { dirs: makeDirs(root), s: {}, untrusted: null, pageErrors: [], restarts: { total: 0, forced: 0 } };
ctx.userData = scratchUserData(source);
// 测试准备（synthetic test setup，§14.1）：给临时项目授权公网，默认范围设为 [DeepSeek, GLM] 的分组
allowRealProject(ctx.userData, Object.entries(ctx.dirs).filter(([key]) => key !== 'markers').map(([, dir]) => dir));
// 复制密文之后的每一步（包括启动）都在 try 里，出错也会删掉临时目录。
try {
  await start(ctx);
  // 数字键按数值先排，其余按写的顺序：1–7、e、r、c。
  const items = { 1: item1, 2: item2, 3: item3, 4: item4, 5: item5, 6: item6, 7: item7, e: itemE, r: itemR,
    c: counterExample };
  for (const [item, fn] of Object.entries(items)) {
    if (wanted(item)) await step(ctx, item === 'c' ? '反例' : `走查 ${item}`, () => fn(ctx));
  }
} catch (error) {
  record('走查：流程', false, oneLine(error, 400));
} finally {
  record('页面没有报错', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  record('关掉窗口后 Mori 自己退出（每次重启）', ctx.restarts.forced === 0,
    `重启 ${ctx.restarts.total} 次，其中 ${ctx.restarts.forced} 次 20 秒内没有退出、由测试关闭`);
  await ctx.app?.close().catch(() => {});
  rmSync(ctx.userData, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
process.exitCode = write(`m3-real${suffix}.json`) ? 0 : 1;
