// Customize › Agents 的 App 套件（docs/specs/customize-agents.md §9；状态表 docs/v1/screens/customize-agents.md）：
// 真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（synthetic，只为提供商的地址有人应答，这一节不发模型请求）。
// 每一步对应 §9.2 的一个编号，检查名以编号开头：分节与列表（AG-01）、候选与原因（AG-02）、有问题的文件（AG-03）、
// 新建（AG-04）、保存的校验（AG-05）、编辑（AG-06）、删除（AG-07）、模型菜单的 Manage agents（AG-08）、
// 展开的内容（AG-09）、操作记录（AG-10）。AG-11 的现有套件由 v1-models-existing.mjs --id AG-11 跑。
// 数据目录、项目与 agent 文件都是测试写的（ag-helpers.mjs，synthetic）。端口 4960、4961（约定的 4960–4969）。
// "Open in default app"只在主进程的 shell.openPath 换成记录路径之后才点（不真的打开编辑器）。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/ag-app.mjs [--exe <Mori.exe>] [--only AG-04,AG-07]
// 结果写到 test-results/ag-app(-packaged).json；--only 时写 ag-partial-app(-packaged).json（覆盖检查不认它）。
// 每一步自己打开要用的项目、需要的文件不在时自己写好，所以 --only 可以只跑其中几步。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import {
  PORTS, addModelRange, agArgs, agentsSnapshot, customizeSections, detailOf, dragModelRange, formSnapshot,
  modelListState, prepareAgentProjects, loopAgentsDir, pressModelHandle, rowLocator, seedAgentsUserData, seenText,
  setCheck, setExpanded, unloopAgentsDir, watchText, writeAgentFile, writeRawAgentFile,
} from './ag-helpers.mjs';
import { until } from './m3-helpers.mjs';
import { openToolsSection } from './m6-helpers.mjs';
import { saveIssueReport } from './md-form-helpers.mjs';
import {
  bridge, brief, clickTeamSwitch, closeTbApp, openProject, paneSel, showTab, sleep, startTbApp, startTbEndpoint,
  stopTbEndpoint, tbRecorder, teamStateOf, userSession,
} from './tb-helpers.mjs';

const args = agArgs();
const { record, finish } = tbRecorder(args);
const ctx = { exePath: args.exePath, userData: null, pageErrors: [], appLog: [] };
/** 项目文件夹：team、broken、empty、edit（ag-helpers.prepareAgentProjects） */
let projects = null;
/** 每个项目打开的会话（chat-pane 的 data-tab） */
const tabs = {};

const SECTIONS = ['builtin', 'skills', 'roles', 'mcp', 'plugins', 'agents'];
const LABELS = ['Built-in tools', 'Skills', 'Agents', 'MCP', 'Plugins', 'Instructions'];
const INTRO = 'Agents Mori can hand work to in Task mode. They’re files in this project’s .mori/agents folder.';
const EMPTY = 'No agents in this project yet. Mori does everything in Task mode until you add one.';
const INVALID = 'New sessions in this project won’t start until these agent files are fixed.';
const SAVED = 'Saved · Applies to new sessions';
const TIER_NOTE = 'Handoff tier is how a model fills in the form it hands back at the end of a task: A, B, or C '
  + '(weakest). Mori finds it when it checks the model.';
const COMMENTS = 'Saving rewrites this file’s header and removes its comments.';
const GONE = 'This agent file no longer exists.';
const DELETE_TEXT = '.mori/agents/reviewer.md will be permanently deleted. This can’t be undone. Sessions already '
  + 'open aren’t affected.';
const LEAVE_TEXT = 'Your edits haven’t been saved. Leaving now discards them.';
const ALL_JOBS = 'Talks to you · Plans requests · Closes requests';
/** 表单各字段下面的说明（§6.4）：Name、Description、Jobs、Prompt */
const HINTS = ['Lowercase letters, digits, and -. The file is saved as .mori/agents/<name>.md.',
  'Other agents read this when they decide who does what.',
  'Leave all off for an agent that only works on tasks. Jobs no agent takes stay with Mori.',
  'What this agent does and how. Added to its system prompt.'];

// ---------- 准备 ----------

/** @brief 项目、数据目录、合成端点，启动 Mori。 */
async function setup() {
  projects = prepareAgentProjects();
  ctx.userData = seedAgentsUserData();
  ctx.endpoint = await startTbEndpoint(PORTS.endpoint, PORTS.proxy);
  await startTbApp(ctx);
}

/** @brief 让 key 项目的会话显示出来（第一次时打开文件夹），返回它的标识。 */
async function tabOf(key) {
  await leaveCustomize();
  if (tabs[key]) {
    await showTab(ctx, tabs[key]);
    return tabs[key];
  }
  tabs[key] = await openProject(ctx, projects[key]);
  if (key !== 'empty') await pickRange(tabs[key]);
  return tabs[key];
}

/** @brief 会话的模型范围设成 ds（数据目录的 normalDefault 是 null，新会话没有范围；empty 项目留着没有范围）。 */
async function pickRange(tab) {
  const { sessionId } = await userSession(ctx, tab);
  await bridge(ctx, { type: 'session.setPick', sessionId, pick: 'ds' });
}

/** @brief 工具页开着时点 Back to app。 */
async function leaveCustomize() {
  const back = ctx.page.getByTestId('tools-page').getByRole('button', { name: 'Back to app' });
  if (await back.isVisible().catch(() => false)) await back.click();
}

/** @brief 打开 key 项目的 Customize › Agents，等列表读到。 */
async function openAgents(key) {
  await tabOf(key);
  await openToolsSection(ctx.page, 'roles');
  await ctx.page.getByTestId('agents-page').waitFor({ timeout: 10000 });
  await ctx.page.waitForFunction(() => {
    const root = document.querySelector('[data-testid="agents-page"]');
    return root && !root.textContent.includes('Loading…') && root.querySelector('[data-testid="agent-row"]');
  }, null, { timeout: 30000 });
}

/** @brief key 项目的会话的 roles.get 结果（与界面对照）。 */
async function rolesInfo(key) {
  const { sessionId } = await userSession(ctx, tabs[key]);
  return (await bridge(ctx, { type: 'roles.get', sessionId })).info;
}

/** @brief 确认框的标题与说明。 */
async function dialogText(dialog) {
  return { title: await dialog.locator('h2').textContent(), text: await dialog.locator('p').first().textContent() };
}

/** @brief 一行 agent 文件的全文。 */
const agentText = (key, file) => readFileSync(join(projects[key], '.mori', 'agents', file), 'utf8');
const agentExists = (key, file) => existsSync(join(projects[key], '.mori', 'agents', file));
const removeAgent = (key, file) => rmSync(join(projects[key], '.mori', 'agents', file), { force: true });
const names = (snap) => snap?.rows.map((row) => row.name) ?? null;
const rowOf = (snap, name) => snap?.rows.find((row) => row.name === name) ?? null;

// ---------- AG-01 分节与列表 ----------

/** @brief 没有会话时没有 Agents 一节（启动后还没打开项目时）。 */
async function noSessionSections() {
  await ctx.page.getByTestId('nav-tools').click();
  await ctx.page.getByTestId('tools-page').waitFor({ timeout: 10000 });
  const seen = await customizeSections(ctx.page);
  record('AG-01 with no open session Customize has no Agents section (Skills, Plugins, Instructions)',
    JSON.stringify(seen.sections) === JSON.stringify(['skills', 'plugins', 'agents']), brief(seen));
  await leaveCustomize();
}

/** @brief 有会话时的分节顺序，列表的 Mori 与文件各行。 */
async function listRows() {
  await openAgents('team');
  const seen = await customizeSections(ctx.page);
  record('AG-01 with a session the sections are Built-in tools, Skills, Agents, MCP, Plugins, Instructions',
    JSON.stringify(seen.sections) === JSON.stringify(SECTIONS) && JSON.stringify(seen.labels) === JSON.stringify(LABELS)
    && seen.current === 'roles', brief(seen));
  const snap = await agentsSnapshot(ctx.page);
  record('AG-01 the header: "Agents", the one-line explanation and New agent', snap?.heading === 'Agents'
    && snap.intro === INTRO && snap.newAgent, brief(snap && { heading: snap.heading, intro: snap.intro }));
  const mori = rowOf(snap, 'mori');
  record('AG-01 Mori is the first row: Built-in, its description, the jobs nobody claimed', names(snap)?.[0] === 'mori'
    && mori.scope === 'builtin' && mori.title === 'Mori' && JSON.stringify(mori.tags) === '["Built-in"]'
    && mori.description === 'General-purpose agent with the default tools' && mori.jobs === 'Talks to you',
  brief(mori));
  const checker = rowOf(snap, 'checker');
  const planner = rowOf(snap, 'planner');
  record('AG-01 agent files follow by file name, tagged Project, with the description’s first line and their jobs',
    JSON.stringify(names(snap)) === JSON.stringify(['mori', 'checker', 'planner', 'tiny', 'watcher'])
    && snap.rows.slice(1).every((row) => row.scope === 'project' && row.valid === 'true'
      && JSON.stringify(row.tags) === '["Project"]')
    && checker.description === 'Checks the work: runs "tests"' && checker.jobs === null
    && planner.jobs === 'Plans requests · Closes requests', brief(snap?.rows));
}

/** @brief 没有 agent 文件的项目：只有 Mori（持有三项职责）和空状态的文字。 */
async function emptyProject() {
  await openAgents('empty');
  const snap = await agentsSnapshot(ctx.page);
  record('AG-01 a project without agent files shows only Mori, holding every job, and the empty-state text',
    JSON.stringify(names(snap)) === '["mori"]' && snap.rows[0].jobs === ALL_JOBS && snap.empty === EMPTY,
    brief(snap));
}

/**
 * @brief 进入这一节先 Loading…；.mori/agents 读不出（指向自己的目录联接，ELOOP）时 Couldn’t load agents 与 Retry；
 *        修好后点 Retry 读到列表。
 */
async function loadingAndFailure() {
  const { page } = ctx;
  await tabOf('looped');
  loopAgentsDir(projects.looped);
  await openToolsSection(page, 'skills');
  await watchText(page, 'loading', '[data-testid="agents-page"]', 'Loading…');
  await page.locator('[data-testid="tools-nav"] button[data-section="roles"]').click();
  const error = await until(() => page.getByTestId('agents-error').textContent().catch(() => null), 15000);
  record('AG-01 entering Agents shows Loading… until the list is read', await seenText(page, 'loading'));
  const retry = await page.getByTestId('agents-error').getByRole('button', { name: 'Retry' }).isVisible();
  record('AG-01 a .mori/agents folder that can’t be read shows "Couldn’t load agents: <text>" and Retry',
    Boolean(error?.startsWith('Couldn’t load agents: ELOOP')) && retry, brief(error));
  unloopAgentsDir(projects.looped);
  await page.getByTestId('agents-error').getByRole('button', { name: 'Retry' }).click();
  const fixed = await until(async () => {
    const snap = await agentsSnapshot(page);
    return snap?.rows.some((row) => row.name === 'fixed') ? snap : null;
  }, 10000);
  record('AG-01 after the folder is fixed, Retry lists its agents', Boolean(fixed) && fixed.error === null,
    brief(fixed?.rows ?? null));
}

// ---------- AG-02 候选与原因 ----------

/** @brief 会话没有模型范围（empty 项目）：Mori 的一句话 No model range picked，展开后没有候选。 */
async function noRange() {
  await openAgents('empty');
  const mori = rowOf(await agentsSnapshot(ctx.page), 'mori');
  await setExpanded(ctx.page, 'mori', true);
  const detail = await detailOf(ctx.page, 'mori');
  record('AG-02 with no model range the line says "No model range picked"; expanded, "The session has no model '
    + 'range." and no candidates', mori?.models?.state === 'empty' && mori.models.text === 'No model range picked'
    && detail?.modelsHeading === 'The session has no model range.' && detail.candidates.length === 0,
  brief({ mori, detail }));
}

/** @brief 每一行的一句话与后台进程 roles.get 的候选一致；几种写法。 */
async function modelLines() {
  await openAgents('team');
  const info = await rolesInfo('team');
  const snap = await agentsSnapshot(ctx.page);
  const want = { mori: ['ready', 'Models: deepseek-chat'], checker: ['some', '1 of 2 models can’t run'],
    planner: ['ready', 'Models: deepseek-chat'], tiny: ['none', 'No model can run this agent'],
    watcher: ['none', 'No model can run this agent'] };
  const seen = Object.fromEntries(snap.rows.map((row) => [row.name, [row.models?.state, row.models?.text]]));
  record('AG-02 the model line: all ready names the first model, some can’t run counts them, none says so',
    info?.pick === 'ds' && JSON.stringify(seen) === JSON.stringify(want), brief({ pick: info?.pick, seen }));
  const mismatched = [];
  for (const agent of info.agents) {
    await setExpanded(ctx.page, agent.name, true);
    const shown = (await detailOf(ctx.page, agent.name)).candidates;
    const expected = agent.candidates.map((item) => ({ ref: item.ref, ready: String(item.reason === null),
      text: `${item.ref}${item.reason ?? 'Ready'}` }));
    if (JSON.stringify(shown) !== JSON.stringify(expected)) mismatched.push({ name: agent.name, shown, expected });
    await setExpanded(ctx.page, agent.name, false);
  }
  record('AG-02 expanded, every candidate shows Ready or the selector’s reason, exactly as roles.get gives them',
    mismatched.length === 0, brief(mismatched));
  const reasons = info.agents.flatMap((agent) => agent.candidates.map((item) => item.reason)).filter(Boolean);
  record('AG-02 the reasons include "handoff tier C is below B" and the effective window for context>=65536',
    reasons.includes('handoff tier C is below B')
      && reasons.some((text) => /^effective window \d+ < 65536$/.test(text)),
    brief(reasons));
}

// ---------- AG-03 有问题的文件 ----------

/** @brief 有问题的项目：会话被拒绝启动的卡、列表上方的警示、每个文件的问题行与卡上的相同、只有 Open 与 Delete…。 */
async function problemFiles() {
  const tab = await tabOf('broken');
  const card = await until(() => ctx.page.locator(`${paneSel(tab)} [data-testid="agent-problem"]`).allTextContents()
    .then((lines) => (lines.length ? lines : null)), 15000);
  await openAgents('broken');
  const snap = await agentsSnapshot(ctx.page);
  const shown = snap.rows.flatMap((row) => row.problems);
  record('AG-03 the warning above the list, and the rows’ problem lines are exactly the "Fix the agent files" card’s',
    snap.invalid === INVALID && Array.isArray(card) && card.length === 2
      && JSON.stringify(shown) === JSON.stringify(card),
    brief({ invalid: snap.invalid, card, shown }));
  const alpha = rowOf(snap, 'alpha');
  const broken = rowOf(snap, 'c');
  record('AG-03 a problem file is named by its header name (or file name), tagged Project and Can’t be used',
    alpha?.valid === 'false' && JSON.stringify(alpha.tags) === '["Project","Can’t be used"]'
    && broken?.valid === 'false'
    && JSON.stringify(names(snap)) === '["mori","alpha","beta","c"]', brief(snap.rows));
  await setExpanded(ctx.page, 'alpha', true);
  const detail = await detailOf(ctx.page, 'alpha');
  record('AG-03 expanded, a problem file has only the File block: Open in default app and Delete…, no Edit',
    JSON.stringify(detail?.blocks) === '["file"]' && detail.file === '.mori/agents/a.md'
    && JSON.stringify(detail.actions) === '["Open in default app","Delete…"]', brief(detail));
  const beta = rowOf(snap, 'beta');
  record('AG-03 the good file in the same folder is listed as usual', beta?.valid === 'true'
    && beta.models?.state === 'ready' && beta.problems.length === 0, brief(beta));
}

// ---------- AG-04 新建 ----------

/** @brief 打开 New agent 表单，返回它此刻的样子。 */
async function openNewForm() {
  await ctx.page.getByTestId('agents-page').locator('[data-action="new-agent"]').click();
  await ctx.page.getByTestId('agent-form').waitFor({ timeout: 5000 });
  return formSnapshot(ctx.page);
}

/** @brief 新表单的默认值与说明。 */
function checkNewDefaults(form) {
  const jobs = form?.jobs.map((job) => [job.label.replace(/planner does this$/, '').trim(), job.checked, job.disabled]
    .join(':'));
  record('AG-04 the New agent form: six fields with their hints; no jobs, the session’s range, Same as Mori, no prompt',
    form?.mode === 'new' && form.name === '' && form.description === '' && form.prompt === ''
    && form.modelsChoice === 'session' && form.toolsChoice === 'same' && form.saveDisabled === true
    && form.count === '0/200' && JSON.stringify(form.hints) === JSON.stringify(HINTS) && form.nameHint === HINTS[0]
    && JSON.stringify(jobs) === JSON.stringify(['Talks to you:false:false', 'Plans requests:false:false',
      'Closes requests:false:true']) && JSON.stringify(form.holders) === '["planner does this"]', brief(form));
}

/** @brief 柄的悬停（Claude 的说法，同 Settings › Models）。 */
const REORDER_TITLE = 'Drag or use the arrow keys to reorder';

/** @brief strong 的柄上先按下、再按上：各自之后的顺序与 modelListState。 */
async function pressBothWays(page) {
  const down = await pressModelHandle(page, 'strong', 'ArrowDown');
  const downList = (await formSnapshot(page)).modelList;
  const up = await pressModelHandle(page, 'strong', 'ArrowUp');
  const upList = (await formSnapshot(page)).modelList;
  return { down, downList, up, upList };
}

/**
 * @brief 表单的模型列表用 Settings › Models 的拖动排序（规格 §6.4、状态表“选模型”）：一项时没有柄，两项时每项一个柄；
 *        拖到另一项的上半边时那一项上沿一条线、被拖的项变淡，放下后排到它前面；方向键移一格、焦点留在柄上；每次移动都播报。
 */
function checkReorder({ one, two, during, dragged, down, downList, up, upList }) {
  const said = (position) => `strong was dropped at position ${position} of 2.`;
  record('AG-04 the model list reorders as in Settings › Models: a Reorder handle from two items, a line where it drops,'
    + ' arrow keys that keep focus, and each move announced',
  JSON.stringify(one.handles) === '[null]'
    && JSON.stringify(two.handles) === JSON.stringify([`Reorder zg/glm-4.6|${REORDER_TITLE}`,
      `Reorder strong|${REORDER_TITLE}`])
    && JSON.stringify(during.drops) === '["zg/glm-4.6:before"]' && JSON.stringify(during.dragging) === '["strong"]'
    && / 0px 2px 0px 0px inset$/.test(during.lines[0] ?? '')
    && JSON.stringify(dragged) === '["strong","zg/glm-4.6"]'
    && JSON.stringify(downList) === '["zg/glm-4.6","strong"]' && down.focus === 'Reorder strong' && down.said === said(2)
    && JSON.stringify(upList) === '["strong","zg/glm-4.6"]' && up.focus === 'Reorder strong' && up.said === said(1),
  brief({ one: one.handles, two: two.handles, during, dragged, down, downList, up, upList }));
}

/** @brief 填好表单：名字、说明、职责、模型（两项，拖动与方向键换顺序）、工具、正文。 */
async function fillReviewer() {
  const { page } = ctx;
  const form = page.getByTestId('agent-form');
  await form.getByLabel('Name', { exact: true }).fill('reviewer');
  await form.getByLabel('Description', { exact: true }).fill('Reviews the change: runs "tests"');
  await setCheck(page, 'agent-jobs-field', 'Plans requests', true);
  await form.getByRole('radio', { name: 'Use these, in order' }).check();
  const emptyList = await formSnapshot(page);
  await addModelRange(page, 'zg/glm-4.6');
  const one = await modelListState(page);
  await addModelRange(page, 'strong');
  const added = (await formSnapshot(page)).modelList;
  const two = await modelListState(page);
  const during = await dragModelRange(page, 'strong', 'zg/glm-4.6', 'before');
  const dragged = (await formSnapshot(page)).modelList;
  checkReorder({ one, two, during, dragged, ...await pressBothWays(page) });
  await form.getByRole('radio', { name: 'Only these' }).check();
  const noTools = await formSnapshot(page);
  for (const tool of ['read', 'grep', 'All MCP tools']) await setCheck(page, 'agent-tools-field', tool, true);
  await form.getByLabel('Prompt', { exact: true }).fill('Review the diff.\nRun the tests.');
  record('AG-04 Models: an ordered list from Add model range, reordered by dragging; Save waits for a model and a tool',
    emptyList.saveDisabled === true && JSON.stringify(added) === '["zg/glm-4.6","strong"]'
    && JSON.stringify(dragged) === '["strong","zg/glm-4.6"]' && noTools.saveDisabled === true,
  brief({ emptyList: emptyList.saveDisabled, added, dragged, noTools: noTools.saveDisabled }));
}

/** @brief 写出的文件（§5.1）。 */
const REVIEWER_FILE = ['---', 'name: reviewer', 'description: "Reviews the change: runs \\"tests\\""',
  'tools: [read, grep, "mcp__*"]', 'models: [strong, zg/glm-4.6]', 'seats: [create]', '---', '', 'Review the diff.',
  'Run the tests.', ''].join('\n');

/** @brief New agent：表单、保存、写出的文件、已经打开的会话不变、新会话有它。 */
async function createAgent() {
  removeAgent('edit', 'reviewer.md');
  await openAgents('edit');
  const before = await userSession(ctx, tabs.edit);
  checkNewDefaults(await openNewForm());
  await fillReviewer();
  await watchText(ctx.page, 'saving', '[data-testid="agent-form"]:has(fieldset:disabled) .form-actions', 'Saving…');
  await ctx.page.getByTestId('agent-form').getByRole('button', { name: 'Save', exact: true }).click();
  await ctx.page.getByTestId('agent-form').waitFor({ state: 'detached', timeout: 10000 });
  record('AG-04 while saving, the button reads "Saving…" and the form can’t be changed',
    await seenText(ctx.page, 'saving'));
  const snap = await agentsSnapshot(ctx.page);
  const row = rowOf(snap, 'reviewer');
  record('AG-04 after Save the form closes and the new row is open with "Saved · Applies to new sessions"',
    row?.expanded === 'true' && row.saved === SAVED && row.jobs === 'Plans requests', brief(row));
  const text = agentExists('edit', 'reviewer.md') ? agentText('edit', 'reviewer.md') : null;
  record('AG-04 the file .mori/agents/reviewer.md is written exactly as §5.1 says', text === REVIEWER_FILE,
    brief(text));
  const open = await teamStateOf(ctx, before.sessionFile);
  await ctx.page.getByTestId('tools-page').getByRole('button', { name: 'New session' }).click();
  const fresh = await until(async () => {
    const tab = await ctx.page.locator('.pane-slot:not([hidden]) [data-testid="chat-pane"]').first()
      .getAttribute('data-tab');
    return tab && tab !== tabs.edit ? tab : null;
  }, 30000);
  const created = fresh ? await userSession(ctx, fresh) : null;
  const team = created ? await until(() => teamStateOf(ctx, created.sessionFile), 30000) : null;
  record('AG-04 the session already open still has its old agents; a new session has reviewer, holding Plans requests',
    !open.roles.some((role) => role.name === 'reviewer') && team?.roles.some((role) => role.name === 'reviewer')
    && team.holders.create === 'reviewer', brief({ open: open.roles, fresh: team?.roles, holders: team?.holders }));
  tabs.edit = fresh ?? tabs.edit;
  if (fresh) await pickRange(fresh);
}

/** @brief 表单有改动时换分节先问；Keep editing 留下，Discard 才离开。 */
async function leaveUnsaved() {
  await openAgents('edit');
  await openNewForm();
  await ctx.page.getByTestId('agent-form').getByLabel('Name', { exact: true }).fill('draft');
  await ctx.page.locator('[data-testid="tools-nav"] button[data-section="skills"]').click();
  const dialog = ctx.page.getByTestId('leave-dialog');
  await dialog.waitFor({ timeout: 5000 });
  const asked = await dialogText(dialog);
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  const kept = await formSnapshot(ctx.page);
  await ctx.page.locator('[data-testid="tools-nav"] button[data-section="skills"]').click();
  await dialog.getByRole('button', { name: 'Discard' }).click();
  const after = await customizeSections(ctx.page);
  record('AG-04 leaving a changed form asks "Discard this agent?"; Keep editing keeps it, Discard leaves',
    asked.title === 'Discard this agent?' && asked.text === LEAVE_TEXT && kept?.name === 'draft'
    && after.current === 'skills', brief({ asked, kept: kept?.name, after }));
}

/** @brief 表单有改动时打开别的表单（另一行的 Edit）、点侧栏的另一个会话也先问；Keep editing 留在表单上。 */
async function leaveOther() {
  await openAgents('edit');
  await openNewForm();
  await ctx.page.getByTestId('agent-form').getByLabel('Name', { exact: true }).fill('draft');
  await setExpanded(ctx.page, 'planner', true);
  await rowLocator(ctx.page, 'planner').locator('[data-action="edit-agent"]').click();
  const dialog = ctx.page.getByTestId('leave-dialog');
  const byForm = await dialog.waitFor({ timeout: 5000 }).then(() => dialogText(dialog), () => null);
  if (byForm) await dialog.getByRole('button', { name: 'Keep editing' }).click();
  const keptForm = await formSnapshot(ctx.page);
  await ctx.page.locator('.session-item:not(.active)').first().click();
  const bySession = await dialog.waitFor({ timeout: 5000 }).then(() => dialogText(dialog), () => null);
  if (bySession) await dialog.getByRole('button', { name: 'Keep editing' }).click();
  const keptSession = await formSnapshot(ctx.page);
  record('AG-04 with a changed form, opening another agent’s Edit or another session in the sidebar asks first; '
    + 'Keep editing keeps the form', byForm?.title === 'Discard this agent?'
    && bySession?.title === 'Discard this agent?'
    && keptForm?.mode === 'new' && keptForm.name === 'draft' && keptSession?.name === 'draft',
  brief({ byForm, bySession, keptForm: keptForm?.name, keptSession: keptSession?.name }));
  await ctx.page.getByTestId('agent-form').getByRole('button', { name: 'Cancel' }).click();
}

/** @brief 表单有改动时点 Back to app 也先问；Discard 后回到会话。 */
async function leaveBack() {
  await openAgents('edit');
  await openNewForm();
  await ctx.page.getByTestId('agent-form').getByLabel('Name', { exact: true }).fill('draft');
  await ctx.page.getByTestId('tools-page').getByRole('button', { name: 'Back to app' }).click();
  const dialog = ctx.page.getByTestId('leave-dialog');
  await dialog.waitFor({ timeout: 5000 });
  const asked = await dialogText(dialog);
  await dialog.getByRole('button', { name: 'Discard' }).click();
  await ctx.page.getByTestId('tools-page').waitFor({ state: 'detached', timeout: 5000 });
  record('AG-04 Back to app with a changed form asks "Discard this agent?" too; Discard goes back to the session',
    asked.title === 'Discard this agent?' && asked.text === LEAVE_TEXT, brief(asked));
}

// ---------- AG-05 保存的校验 ----------

/** @brief 填名字与说明后点 Save，返回表单此刻的错误与文字。 */
async function trySave(name, description = 'Some agent') {
  const form = ctx.page.getByTestId('agent-form');
  await form.getByLabel('Name', { exact: true }).fill(name);
  await form.getByLabel('Description', { exact: true }).fill(description);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await until(async () => (await formSnapshot(ctx.page))?.error ?? null, 10000);
  return formSnapshot(ctx.page);
}

/** @brief 名字的规则、重名、文件已存在：不写文件，表单留着你写的，下面 Couldn’t save: 和问题行。 */
async function refusedSaves() {
  writeAgentFile(projects.edit, 'rev.md', { name: 'taken', description: 'Its name differs from its file name' });
  await openAgents('edit');
  const before = agentFileList();
  await openNewForm();
  const cases = [['mori', 'name "mori" is reserved for the base agent'],
    ['taken', 'name "taken" is already used by .mori/agents/rev.md'],
    ['planner', 'A file named .mori/agents/planner.md already exists.']];
  const seen = [];
  for (const [name, line] of cases) {
    const form = await trySave(name);
    seen.push({ name, error: form?.error, kept: form?.name === name, ok: form?.error === `Couldn’t save:\n${line}` });
  }
  record('AG-05 a reserved name, a name another file uses and an existing <name>.md are refused with those lines; '
    + 'the form keeps what you typed and no file is written', seen.every((item) => item.ok && item.kept)
    && JSON.stringify(agentFileList()) === JSON.stringify(before), brief(seen));
  await ctx.page.getByTestId('agent-form').getByRole('button', { name: 'Cancel' }).click();
  removeAgent('edit', 'rev.md');
}

/** @brief edit 项目 .mori/agents 里的文件名。 */
function agentFileList() {
  return ['commented.md', 'helper.md', 'planner.md', 'rev.md', 'reviewer.md', 'zz-broken.md']
    .filter((file) => agentExists('edit', file));
}

/** @brief Save 不可用的几种情况，说明的计数与 200 字的上限，被认领的职责。 */
async function saveDisabled() {
  await openAgents('edit');
  await openNewForm();
  const { page } = ctx;
  const form = page.getByTestId('agent-form');
  const states = {};
  states.empty = (await formSnapshot(page)).saveDisabled;
  await form.getByLabel('Name', { exact: true }).fill('helper');
  states.noDescription = (await formSnapshot(page)).saveDisabled;
  await form.getByLabel('Description', { exact: true }).fill('x'.repeat(205));
  const long = await formSnapshot(page);
  await form.getByRole('radio', { name: 'Use these, in order' }).check();
  states.noModels = (await formSnapshot(page)).saveDisabled;
  await form.getByRole('radio', { name: 'Same as the session’s model range' }).check();
  await form.getByRole('radio', { name: 'Only these' }).check();
  states.noTools = (await formSnapshot(page)).saveDisabled;
  await form.getByRole('radio', { name: 'Same as Mori' }).check();
  states.ready = (await formSnapshot(page)).saveDisabled;
  record('AG-05 Save is unavailable without a name, a description, a model in the list or a tool; the description '
    + 'stops at 200 characters with an n/200 count', JSON.stringify(states) === JSON.stringify({ empty: true,
    noDescription: true, noModels: true, noTools: true, ready: false }) && long.description.length === 200
    && long.count === '200/200', brief({ states, count: long.count }));
  const closes = long.jobs.find((job) => job.label.startsWith('Closes requests'));
  record('AG-05 a job another file claims can’t be ticked and says who does it', closes?.disabled === true
    && long.holders.includes('planner does this'), brief(long.jobs));
  await form.getByRole('button', { name: 'Cancel' }).click();
}

/** @brief 别的文件有问题不挡保存。 */
async function othersProblems() {
  writeRawAgentFile(projects.edit, 'zz-broken.md', '---\nname: broken\ndescription: x\ncolour: blue\n---\n');
  removeAgent('edit', 'helper.md');
  await openAgents('edit');
  await openNewForm();
  await ctx.page.getByTestId('agent-form').getByLabel('Name', { exact: true }).fill('helper');
  await ctx.page.getByTestId('agent-form').getByLabel('Description', { exact: true }).fill('Helps');
  await ctx.page.getByTestId('agent-form').getByRole('button', { name: 'Save', exact: true }).click();
  await ctx.page.getByTestId('agent-form').waitFor({ state: 'detached', timeout: 10000 });
  const snap = await agentsSnapshot(ctx.page);
  record('AG-05 another file’s own problems don’t block saving this one', agentExists('edit', 'helper.md')
    && rowOf(snap, 'helper')?.saved === SAVED && rowOf(snap, 'broken')?.valid === 'false', brief(snap.rows));
  removeAgent('edit', 'zz-broken.md');
  removeAgent('edit', 'helper.md');
}

// ---------- AG-06 编辑 ----------

/** @brief edit 项目的 commented.md（文件头有注释，带 requires、differ_from、subscribe）。 */
function writeCommented() {
  writeAgentFile(projects.edit, 'commented.md', { name: 'commented', description: 'Written by hand', tools: ['read'],
    models: ['ds'], requires: ['vision'], differ_from: 'author', subscribe: ['request_closed'] },
  'Hand-written prompt.', 'hand-written header');
}

/** @brief 点一行展开后的 Edit，等表单出来。 */
async function openEdit(name) {
  await setExpanded(ctx.page, name, true);
  await rowLocator(ctx.page, name).locator('[data-action="edit-agent"]').click();
  await ctx.page.getByTestId('agent-form').waitFor({ timeout: 5000 });
  return formSnapshot(ctx.page);
}

/** @brief Edit：预填、注释的提示、文件名不变、保留的字段。 */
async function editAgent() {
  writeCommented();
  await openAgents('edit');
  const form = await openEdit('commented');
  record('AG-06 Edit fills the form with the file’s values and warns that the header’s comments go',
    form?.mode === 'edit' && form.name === 'commented' && form.description === 'Written by hand'
    && form.modelsChoice === 'list' && JSON.stringify(form.modelList) === '["ds"]' && form.toolsChoice === 'only'
    && JSON.stringify(form.tools.filter((tool) => tool.checked).map((tool) => tool.label)) === '["read"]'
    && form.prompt === 'Hand-written prompt.' && form.comments === COMMENTS
    && form.nameHint === 'The file name stays .mori/agents/commented.md.', brief(form));
  const box = ctx.page.getByTestId('agent-form');
  await box.getByLabel('Name', { exact: true }).fill('hand');
  await box.getByLabel('Description', { exact: true }).fill('Edited in Mori');
  await box.getByRole('button', { name: 'Save', exact: true }).click();
  await box.waitFor({ state: 'detached', timeout: 10000 });
  const parsed = parseFrontmatter(agentText('edit', 'commented.md'));
  record('AG-06 Save keeps the file name and writes requires, differ_from and subscribe back unchanged, without '
    + 'comments', JSON.stringify(parsed.frontmatter) === JSON.stringify({ name: 'hand', description: 'Edited in Mori',
      tools: ['read'],
      models: ['ds'], requires: ['vision'], differ_from: 'author', subscribe: ['request_closed'] })
    && !agentText('edit', 'commented.md').includes('#') && !agentExists('edit', 'hand.md')
    && rowOf(await agentsSnapshot(ctx.page), 'hand')?.saved === SAVED, brief(parsed));
}

/** @brief 文件在别处删掉之后再保存：This agent file no longer exists.，不写文件。 */
async function editDeletedFile() {
  writeCommented();
  await openAgents('edit');
  await openEdit('commented');
  removeAgent('edit', 'commented.md');
  await ctx.page.getByTestId('agent-form').getByRole('button', { name: 'Save', exact: true }).click();
  const error = await until(async () => (await formSnapshot(ctx.page))?.error ?? null, 10000);
  record('AG-06 saving an edit after the file was deleted elsewhere says "This agent file no longer exists."',
    error === `Couldn’t save:\n${GONE}` && !agentExists('edit', 'commented.md'), brief(error));
  await ctx.page.getByTestId('agent-form').getByRole('button', { name: 'Cancel' }).click();
  writeCommented();
}

// ---------- AG-07 删除 ----------

/** @brief Delete…：确认框的文字、Cancel 不删、Delete 删掉文件与这一行。 */
async function deleteAgent() {
  if (!agentExists('edit', 'reviewer.md')) writeRawAgentFile(projects.edit, 'reviewer.md', REVIEWER_FILE);
  await openAgents('edit');
  await setExpanded(ctx.page, 'reviewer', true);
  const open = () => rowLocator(ctx.page, 'reviewer').locator('[data-action="delete-agent"]').click();
  await open();
  const dialog = ctx.page.getByTestId('agent-delete-dialog');
  await dialog.waitFor({ timeout: 5000 });
  const asked = await dialogText(dialog);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  const kept = agentExists('edit', 'reviewer.md');
  await open();
  await watchText(ctx.page, 'deleting', '[data-testid="agent-delete-dialog"]:has(button:disabled)', 'Deleting…');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 10000 });
  record('AG-07 while deleting, the dialog says "Deleting…" and its buttons are unavailable',
    await seenText(ctx.page, 'deleting'));
  const snap = await agentsSnapshot(ctx.page);
  record('AG-07 Delete… asks "Delete agent “reviewer”?" with the permanent-delete text; Cancel keeps the file',
    asked.title === 'Delete agent “reviewer”?' && asked.text === DELETE_TEXT && kept, brief(asked));
  record('AG-07 Delete removes the file and its row', !agentExists('edit', 'reviewer.md')
    && !names(snap).includes('reviewer'), brief(names(snap)));
}

/** @brief 删除失败（文件在点 Delete 之前换成了同名的文件夹）：确认框里 Couldn’t delete: 和原文，按钮又可用。 */
async function deleteFailure() {
  writeAgentFile(projects.edit, 'stuck.md', { name: 'stuck', description: 'Becomes a folder before Delete' });
  await openAgents('edit');
  await setExpanded(ctx.page, 'stuck', true);
  await rowLocator(ctx.page, 'stuck').locator('[data-action="delete-agent"]').click();
  const dialog = ctx.page.getByTestId('agent-delete-dialog');
  await dialog.waitFor({ timeout: 5000 });
  const path = join(projects.edit, '.mori', 'agents', 'stuck.md');
  rmSync(path);
  mkdirSync(path);
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  const error = await until(() => dialog.getByRole('alert').textContent().catch(() => null), 10000);
  const usable = await dialog.getByRole('button', { name: 'Cancel' }).isEnabled();
  record('AG-07 a failed delete keeps the dialog open with "Couldn’t delete: <text>"', Boolean(error?.startsWith(
    'Couldn’t delete: ')) && usable, brief(error));
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  rmSync(path, { recursive: true, force: true });
}

// ---------- AG-08 Manage agents ----------

/** @brief 打开 tab 一栏的模型菜单，返回 Manage agents 是否在 Task mode 那一行之后、是否可用。 */
async function manageItem(tab) {
  await ctx.page.locator(`${paneSel(tab)} [data-testid="model-button"]`).click();
  const menu = ctx.page.getByTestId('model-menu');
  await menu.waitFor({ timeout: 5000 });
  return menu.evaluate((root) => {
    const item = root.querySelector('[data-action="manage-agents"]');
    const task = [...root.querySelectorAll('*')].find((el) => el.children.length === 0
      && el.textContent.trim() === 'Task mode');
    const after = Boolean(item && task && (task.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING));
    return { present: Boolean(item), text: item?.textContent ?? null, after,
      disabled: item ? item.disabled || item.getAttribute('aria-disabled') === 'true' : null };
  });
}

/** @brief 点 Manage agents：关菜单，Customize 打开并选中 Agents，跟随这个会话。 */
async function clickManage() {
  await ctx.page.getByTestId('model-menu').locator('[data-action="manage-agents"]').click();
  await ctx.page.getByTestId('agents-page').waitFor({ timeout: 10000 });
  const seen = await customizeSections(ctx.page);
  const follow = await ctx.page.getByTestId('tools-follow').textContent();
  const menuGone = !(await ctx.page.getByTestId('model-menu').isVisible().catch(() => false));
  return { current: seen.current, follow, menuGone };
}

/** @brief Task mode 关和开时，模型菜单里 Task mode 那一行下面都有 Manage agents，点了落在 Agents。 */
async function manageAgents() {
  const tab = await tabOf('team');
  const folder = projects.team.split(/[\\/]/).pop();
  const off = await manageItem(tab);
  const offClick = off.present ? await clickManage() : null;
  record('AG-08 with Task mode off the model menu has Manage agents under the Task mode row; it opens Customize › '
    + 'Agents for this session', off.present && off.after && off.text === 'Manage agents'
    && offClick?.current === 'roles' && offClick.menuGone && offClick.follow.startsWith(folder),
  brief({ off, offClick }));
  await tabOf('team');
  await clickTeamSwitch(ctx, tab, true);
  const on = await manageItem(tab);
  const onClick = on.present && !on.disabled ? await clickManage() : null;
  record('AG-08 with Task mode on Manage agents is still there and usable', on.present && on.after && !on.disabled
    && onClick?.current === 'roles', brief({ on, onClick }));
  await tabOf('team');
  await clickTeamSwitch(ctx, tab, false);
}

// ---------- AG-09 展开的内容 ----------

/** @brief 换掉主进程的 shell.openPath，只记下路径。 */
function stubOpenPath() {
  return ctx.app.evaluate(({ shell }) => {
    globalThis.__moriOpened = [];
    shell.openPath = async (path) => {
      globalThis.__moriOpened.push(path);
      return '';
    };
    return String(shell.openPath).includes('__moriOpened');
  });
}

/** @brief Mori、checker、watcher 展开后的各块。 */
async function expansion() {
  await openAgents('team');
  const info = await rolesInfo('team');
  const details = {};
  for (const name of ['mori', 'checker', 'watcher']) {
    await setExpanded(ctx.page, name, true);
    details[name] = await detailOf(ctx.page, name);
  }
  const { mori, checker, watcher } = details;
  record('AG-09 Mori: the session’s model range, Same as Mori with the default tools, no File block',
    JSON.stringify(mori?.blocks) === '["models","tools","prompt"]'
    && mori.modelsHeading === `Same as the session’s model range (${info.pick})`
    && mori.tools === `Same as Mori: ${[...info.baseTools, 'and all MCP tools'].join(', ')}`
    && mori.prompt === 'No prompt',
  brief(mori));
  record('AG-09 an agent with its own models, a handoff tier need, its tools, its prompt and its file',
    JSON.stringify(checker?.blocks) === '["models","needs","tools","prompt","file"]'
    && checker.modelsHeading === 'Tries these in order:'
    && JSON.stringify(checker.needs) === '["Handoff tier B or better"]' && checker.tierNote === TIER_NOTE
    && checker.tools === 'read, grep' && checker.prompt === 'Check the diff.\nRun the tests.'
    && /mono|consolas|courier/i.test(checker.promptFont) && checker.file === '.mori/agents/checker.md'
    && JSON.stringify(checker.actions) === '["Edit","Open in default app","Delete…"]', brief(checker));
  record('AG-09 needs without a tier note, all MCP tools, other settings, and No prompt',
    JSON.stringify(watcher?.needs) === '["Context window of at least 65536 tokens","Image input"]'
    && watcher.tierNote === null && watcher.tools === 'read, all MCP tools'
    && JSON.stringify(watcher.other) === JSON.stringify(['Avoids the model family that changed the code',
      'Woken when a request closes (has ruled-out approaches)']) && watcher.prompt === 'No prompt', brief(watcher));
  const stubbed = await stubOpenPath();
  if (stubbed) {
    await rowLocator(ctx.page, 'checker').getByRole('button', { name: 'Open in default app' }).click();
    await until(() => ctx.app.evaluate(() => (globalThis.__moriOpened ?? []).length > 0), 5000, 100);
  }
  const opened = stubbed ? await ctx.app.evaluate(() => globalThis.__moriOpened ?? []) : [];
  record('AG-09 Open in default app hands the agent file’s path to the system', stubbed
    && opened[0] === join(projects.team, '.mori', 'agents', 'checker.md'), brief(opened));
  await setExpanded(ctx.page, 'checker', false);
  record('AG-09 clicking an open row closes it again', (await rowLocator(ctx.page, 'checker')
    .getAttribute('aria-expanded')) === 'false');
}

/** @brief 系统打不开这个文件时（shell.openPath 返回原因），这一行下面写原因。 */
async function openFailure() {
  await openAgents('team');
  await setExpanded(ctx.page, 'checker', true);
  const reason = 'No application is associated with this file';
  await ctx.app.evaluate(({ shell }, text) => {
    shell.openPath = async () => text;
  }, reason);
  await rowLocator(ctx.page, 'checker').getByRole('button', { name: 'Open in default app' }).click();
  const shown = await until(() => rowLocator(ctx.page, 'checker').locator('.form-message.error').first().textContent()
    .catch(() => null), 5000);
  record('AG-09 when the system can’t open the file the row says "Couldn’t open this file with the default app: '
    + '<text>"', shown === `Couldn’t open this file with the default app: ${reason}`, brief(shown));
}

// ---------- AG-10 操作记录 ----------

/** @brief 保存、删除与 Manage agents 之后，F8 报告的 Recent activity 里有它们。 */
async function activity() {
  removeAgent('edit', 'logged.md');
  await openAgents('edit');
  await openNewForm();
  await ctx.page.getByTestId('agent-form').getByLabel('Name', { exact: true }).fill('logged');
  await ctx.page.getByTestId('agent-form').getByLabel('Description', { exact: true }).fill('Logged');
  await ctx.page.getByTestId('agent-form').getByRole('button', { name: 'Save', exact: true }).click();
  await ctx.page.getByTestId('agent-form').waitFor({ state: 'detached', timeout: 10000 });
  await setExpanded(ctx.page, 'logged', true);
  await rowLocator(ctx.page, 'logged').locator('[data-action="delete-agent"]').click();
  await ctx.page.getByTestId('agent-delete-dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await ctx.page.getByTestId('agent-delete-dialog').waitFor({ state: 'detached', timeout: 10000 });
  const tab = await tabOf('team');
  const item = await manageItem(tab);
  if (item.present) await clickManage();
  else await ctx.page.keyboard.press('Escape');
  const report = await saveIssueReport(ctx.page, 'Agents activity check', 'Recent activity lists the agent actions');
  const lines = report.md.split(/\r?\n/);
  const has = (text) => lines.some((line) => line.includes(text));
  record('AG-10 Recent activity has "Save agent logged" and "Delete agent logged"', has('Save agent logged')
    && has('Delete agent logged'), brief(lines.filter((line) => /agent/i.test(line))));
  record('AG-10 Recent activity has "Open Customize → Agents" after Manage agents', has('Open Customize → Agents'),
    brief(lines.filter((line) => line.includes('Open Customize'))));
}

// ---------- 运行 ----------

/** 编号 → 这一步的函数，按运行的顺序 */
const STEPS = [
  ['AG-01', [noSessionSections, listRows, emptyProject, loadingAndFailure]],
  ['AG-09', [expansion, openFailure]],
  ['AG-02', [modelLines, noRange]],
  ['AG-08', [manageAgents]],
  ['AG-03', [problemFiles]],
  ['AG-04', [createAgent, leaveUnsaved, leaveOther, leaveBack]],
  ['AG-05', [refusedSaves, saveDisabled, othersProblems]],
  ['AG-06', [editAgent, editDeletedFile]],
  ['AG-07', [deleteAgent, deleteFailure]],
  ['AG-10', [activity]],
];

/** @brief 跑一个函数；抛错时记一条失败（检查名以编号开头），截图。 */
async function runStep(id, fn) {
  try {
    await fn();
  } catch (error) {
    record(`${id} ${fn.name} ran without errors`, false, error.stack ?? String(error));
    await ctx.page?.screenshot({ path: join(args.shots, `${id}-${fn.name}.png`) }).catch(() => {});
    await ctx.page?.keyboard.press('Escape').catch(() => {});
    await sleep(300);
  }
}

async function main() {
  try {
    await setup();
    for (const [id, fns] of STEPS) {
      if (args.only && !args.only.includes(id)) continue;
      for (const fn of fns) await runStep(id, fn);
    }
    record('page errors: none', ctx.pageErrors.length === 0, brief(ctx.pageErrors));
  } catch (error) {
    record('setup ran without errors', false, error.stack ?? String(error));
  } finally {
    await closeTbApp(ctx);
    await stopTbEndpoint(ctx.endpoint);
    const ok = finish();
    const dirs = [ctx.userData, ...Object.values(projects ?? {})].filter(Boolean);
    if (ok) for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
}

await main();
writeFileSync(join(args.shots, 'done.txt'), new Date().toISOString());
