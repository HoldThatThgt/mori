// Customize › Agents 的 App 套件（tests/ui/ag-app.mjs，docs/specs/customize-agents.md §9）用的准备与读取：
// - 数据目录（synthetic test setup，同 tb-helpers.seedTeamUserData）：两个提供商、一个分组 strong，跳过探针的档案
//   （glm-4.6 写入等级 C、有效窗口 32768）；
// - 临时项目与 .mori/agents 里的文件：值按 §5.1 的写法加引号（tb-helpers 的 writeRole 不给 description 加引号，
//   说明里有冒号时文件头会坏）；
// - 读 Agents 一节（状态表 docs/v1/screens/customize-agents.md“界面测试用的标识”）：分节、行、展开的各块、表单、确认框。
// 合成端点与它前面的记录代理用 4960、4961（2026-10-26 与走查会话约定的 4960–4969）；这一节不发模型请求，
// 端点只为提供商的地址有人应答。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { arg, appRoot } from './lib.mjs';
import { seedTeamUserData, tbModel, tbProvider, tempProject, tempUserData } from './tb-helpers.mjs';

/** @brief 合成端点与记录代理的端口（4960–4969 里）。 */
export const PORTS = { endpoint: 4960, proxy: 4961 };

/**
 * @brief 命令行：--exe <Mori.exe>、--only AG-01,AG-04（只跑这些编号的步骤，结果写 ag-partial-app(-packaged).json，
 *        覆盖检查不认它）。
 */
export function agArgs() {
  const exePath = arg('exe') ? resolve(arg('exe')) : null;
  const only = arg('only')?.split(',').map((id) => id.trim()).filter(Boolean) ?? null;
  const packaged = exePath ? '-packaged' : '';
  const file = only ? `ag-partial-app${packaged}.json` : `ag-app${packaged}.json`;
  const shots = join(appRoot, `test-results/ag-app${packaged}`);
  mkdirSync(shots, { recursive: true });
  return { suite: 'ag-app', exePath, only, file, shots };
}

/** @brief 提供商与模型（synthetic）：deepseek/deepseek-chat 写入等级 A；glm/glm-4.6 等级 C、窗口 32768；glm/glm-4.5 等级 A。 */
export function seedAgentsUserData() {
  const userData = tempUserData('mori-ag-data-');
  const deepseek = tbProvider('deepseek', PORTS.proxy, [tbModel('deepseek-chat')], { name: 'DeepSeek' });
  const glm = tbProvider('glm', PORTS.proxy, [tbModel('glm-4.6', { contextWindow: 32768 }), tbModel('glm-4.5')],
    { name: 'GLM' });
  seedTeamUserData(userData, {
    providers: [deepseek, glm],
    groups: [{ id: 'strong', members: ['deepseek/deepseek-chat', 'glm/glm-4.6'] }],
    normalDefault: 'deepseek',
    profiles: { 'glm/glm-4.6': { tier: 'C' } },
  });
  return userData;
}

/** @brief JSON 引号写法的 YAML 值：列表单行、每项 JSON；对象 JSON；字符串 JSON。 */
const yamlValue = (value) => (Array.isArray(value) ? `[${value.map((item) => JSON.stringify(item)).join(', ')}]`
  : JSON.stringify(value));

/**
 * @brief 写一个 agent 文件 <project>/.mori/agents/<file>（synthetic）：fields 按给的顺序写成 frontmatter（值加引号），
 *        comment 给出时在文件头第一行写成 # 注释，正文 body。
 * @return 文件的绝对路径
 */
export function writeAgentFile(project, file, fields, body = '', comment = null) {
  const dir = join(project, '.mori', 'agents');
  mkdirSync(dir, { recursive: true });
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${yamlValue(value)}`);
  const head = ['---', ...(comment ? [`# ${comment}`] : []), ...lines, '---'];
  const text = [...head, ...(body ? ['', body] : []), ''].join('\n');
  const path = join(dir, file);
  writeFileSync(path, text);
  return path;
}

/** @brief 写原文的 agent 文件（有问题的文件用）。 */
export function writeRawAgentFile(project, file, text) {
  const dir = join(project, '.mori', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), text);
}

/**
 * @brief 测试用的项目（synthetic）：team（四个合格的 agent）、broken（有问题的文件）、empty（没有 agent 文件）、
 *        edit（新建、编辑、删除用：planner 认领 close，commented 的文件头有注释）。
 */
export function prepareAgentProjects() {
  const team = tempProject('mori-ag-team-');
  writeAgentFile(team, 'checker.md', { name: 'checker', description: 'Checks the work: runs "tests"\nand reports',
    tools: ['read', 'grep'], models: ['strong'], requires: ['protocol_write>=B'] }, 'Check the diff.\nRun the tests.');
  writeAgentFile(team, 'planner.md', { name: 'planner', description: 'Splits each request and closes it',
    models: ['deepseek'], seats: ['create', 'close'] }, 'Plan the work.');
  writeAgentFile(team, 'tiny.md', { name: 'tiny', description: 'Only runs on glm-4.6', models: ['glm/glm-4.6'],
    requires: ['protocol_write>=B'] }, 'Tiny.');
  writeAgentFile(team, 'watcher.md', { name: 'watcher', description: 'Wakes up when a request closes',
    tools: ['read', 'mcp__*'], models: ['strong'], requires: ['context>=65536', 'vision'], differ_from: 'author',
    subscribe: [{ request_closed: { ruled_out: true } }] });
  const broken = tempProject('mori-ag-broken-');
  writeAgentFile(broken, 'a.md', { name: 'alpha', description: 'Has an unknown field', colour: 'blue' });
  writeAgentFile(broken, 'b.md', { name: 'beta', description: 'A good one' }, 'Beta.');
  writeRawAgentFile(broken, 'c.md', '---\nname: [oops\n---\n');
  const empty = tempProject('mori-ag-empty-');
  const edit = tempProject('mori-ag-edit-');
  writeAgentFile(edit, 'planner.md', { name: 'planner', description: 'Closes requests', seats: ['close'] }, 'Plan.');
  writeAgentFile(edit, 'commented.md', { name: 'commented', description: 'Written by hand', tools: ['read'],
    models: ['deepseek'], requires: ['vision'], differ_from: 'author', subscribe: ['request_closed'] },
  'Hand-written prompt.', 'hand-written header');
  return { team, broken, empty, edit };
}

// ---------- 读 Agents 一节 ----------

/** @brief Customize 左边的分节（data-section，按顺序）与当前的那一节。 */
export function customizeSections(page) {
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll('[data-testid="tools-nav"] button[data-section]')];
    return { sections: buttons.map((button) => button.dataset.section),
      labels: buttons.map((button) => button.textContent),
      current: buttons.find((button) => button.getAttribute('aria-current') === 'page')?.dataset.section ?? null };
  });
}

/**
 * @brief Agents 一节此刻的样子：标题、说明、警示、空状态、读取中，每一行的名字、范围、合格、展开、标记、说明、职责、
 *        模型的一句话、问题行、刚保存的提示。
 */
export function agentsSnapshot(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="agents-page"]');
    if (!root) return null;
    const text = (el) => el?.textContent ?? null;
    const rows = [...root.querySelectorAll('[data-testid="agent-row"]')].map((row) => ({
      name: row.dataset.name, scope: row.dataset.scope, valid: row.dataset.valid,
      expanded: row.getAttribute('aria-expanded'),
      title: text(row.querySelector('[data-testid="agent-name"]')),
      tags: [...row.querySelectorAll('[data-testid="agent-tag"]')].map((tag) => tag.textContent),
      description: text(row.querySelector('[data-testid="agent-description"]')),
      jobs: text(row.querySelector('[data-testid="agent-jobs"]')),
      models: row.querySelector('[data-testid="agent-models"]')
        ? { state: row.querySelector('[data-testid="agent-models"]').dataset.state,
          text: row.querySelector('[data-testid="agent-models"]').textContent } : null,
      problems: [...row.querySelectorAll('[data-testid="agent-problem"]')].map((item) => item.textContent),
      saved: text(row.querySelector('[data-testid="agent-saved"]')),
    }));
    return {
      heading: text(root.querySelector('h2')), intro: text(root.querySelector('[data-testid="agents-intro"]')),
      invalid: text(root.querySelector('[data-testid="agents-invalid"]')),
      empty: text(root.querySelector('[data-testid="agents-empty"]')),
      error: text(root.querySelector('[data-testid="agents-error"]')),
      loading: root.textContent.includes('Loading…'),
      newAgent: Boolean(root.querySelector('[data-action="new-agent"]')),
      form: root.querySelector('[data-testid="agent-form"]')?.dataset.mode ?? null,
      rows,
    };
  });
}

/** @brief 一行（按 data-name）的定位。 */
export const rowLocator = (page, name) => page.locator(`[data-testid="agents-page"] [data-testid="agent-row"]`
  + `[data-name="${name}"]`);

/** @brief 展开（或收起）一行：点它的标题按钮，等 aria-expanded 变成 want。 */
export async function setExpanded(page, name, want = true) {
  const row = rowLocator(page, name);
  if ((await row.getAttribute('aria-expanded')) === String(want)) return;
  await row.getByTestId('agent-toggle').click();
  await page.waitForFunction(({ who, value }) => document.querySelector(`[data-testid="agent-row"][data-name="${who}"]`)
    ?.getAttribute('aria-expanded') === value, { who: name, value: String(want) }, { timeout: 5000 });
}

/** @brief 展开的一行里各块的内容（data-block：models、needs、tools、other、prompt、file）。 */
export function detailOf(page, name) {
  return page.evaluate((who) => {
    const row = document.querySelector(`[data-testid="agent-row"][data-name="${who}"]`);
    const detail = row?.querySelector('[data-testid="agent-detail"]');
    if (!detail) return null;
    const block = (key) => detail.querySelector(`[data-block="${key}"]`);
    const items = (key) => [...(block(key)?.querySelectorAll('li') ?? [])].map((item) => item.textContent);
    return {
      blocks: [...detail.querySelectorAll('[data-block]')].map((item) => item.dataset.block),
      modelsHeading: block('models')?.querySelector('[data-testid="agent-models-heading"]')?.textContent ?? null,
      candidates: [...detail.querySelectorAll('[data-testid="agent-candidate"]')].map((item) => ({
        ref: item.dataset.ref, ready: item.dataset.ready, text: item.textContent })),
      needs: items('needs'),
      tierNote: block('needs')?.querySelector('[data-testid="agent-tier-note"]')?.textContent ?? null,
      tools: block('tools')?.querySelector('[data-testid="agent-tools"]')?.textContent ?? null,
      other: items('other'),
      prompt: block('prompt')?.querySelector('[data-testid="agent-prompt"]')?.textContent ?? null,
      promptFont: block('prompt') ? getComputedStyle(block('prompt').querySelector('[data-testid="agent-prompt"]')
        ?? block('prompt')).fontFamily : null,
      file: block('file')?.querySelector('[data-testid="agent-file"]')?.textContent ?? null,
      actions: [...(block('file')?.querySelectorAll('button') ?? [])].map((button) => button.textContent),
    };
  }, name);
}

/** @brief 表单此刻的样子：模式、各字段的值、职责勾选框（可用与否、旁边的说明）、模型与工具的选择、错误、按钮。 */
export function formSnapshot(page) {
  return page.evaluate(() => {
    const form = document.querySelector('[data-testid="agent-form"]');
    if (!form) return null;
    const field = (label) => form.querySelector(`[aria-label="${label}"]`);
    const checks = (testId) => [...form.querySelectorAll(`[data-testid="${testId}"] input[type="checkbox"]`)]
      .map((box) => ({ label: box.closest('label')?.textContent?.trim() ?? '', checked: box.checked,
        disabled: box.disabled }));
    const radio = (name) => form.querySelector(`input[type="radio"][name="${name}"]:checked`)?.value ?? null;
    const save = [...form.querySelectorAll('button')].find((button) => /^Sav/.test(button.textContent));
    return {
      mode: form.dataset.mode, name: field('Name')?.value ?? null, description: field('Description')?.value ?? null,
      prompt: field('Prompt')?.value ?? null,
      count: form.querySelector('[data-testid="agent-desc-count"]')?.textContent ?? null,
      nameHint: form.querySelector('[data-testid="agent-name-hint"]')?.textContent ?? null,
      comments: form.querySelector('[data-testid="agent-form-comments"]')?.textContent ?? null,
      jobs: checks('agent-jobs-field'),
      holders: [...form.querySelectorAll('[data-testid="agent-job-holder"]')].map((item) => item.textContent),
      modelsChoice: radio('agent-models'), toolsChoice: radio('agent-tools'),
      modelList: [...form.querySelectorAll('[data-testid="agent-model-list"] li')].map((item) => item.dataset.pick),
      tools: checks('agent-tools-field'),
      error: form.querySelector('[data-testid="agent-form-error"]')?.innerText ?? null,
      saveText: save?.textContent ?? null, saveDisabled: save?.disabled ?? null,
      hints: [...form.querySelectorAll('.agent-field-hint')].map((item) => item.textContent),
    };
  });
}

/** @brief 在表单里勾选或取消一个勾选框（按它的文字，在 testId 那一组里）。 */
export async function setCheck(page, testId, label, checked) {
  const box = page.getByTestId('agent-form').getByTestId(testId).getByRole('checkbox', { name: label, exact: true });
  if (checked) await box.check();
  else await box.uncheck();
}

/** @brief 在 Add model range 下拉里选一项（value 为 pick）。 */
export async function addModelRange(page, pick) {
  await page.getByTestId('agent-form').getByLabel('Add model range').selectOption(pick);
}
