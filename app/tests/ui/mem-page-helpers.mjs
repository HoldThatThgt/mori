// 记忆页 App 套件（tests/ui/mem-app-page.mjs）用的准备、读取与操作（docs/specs/memory.md §3、§6.3、§9.1、§10；
// 状态表 docs/v1/screens/memory-page.md、memory-chat.md、settings-issues.md）：
// - 按 §3 的格式写记忆文件（synthetic test setup，逐个注明）：索引、detail、修订记录、project.json、enhance.json；
// - 测试一侧照 §6.3 写的 token 估算与用量、§9.2 的日子、日期写法（与 App 的结果对照，不 import 被测代码）；
// - 读记忆页：层、分节、用量、Last change、列表、Revisions 列表、AGENT、增强一块，右栏的条目、表单与修订；
// - 常用操作：打开记忆页、Back to app、换层与分节、选行、表单、删除、移动、回滚，等页面读完。
// 只读页面和磁盘、发界面操作，不记录检查结果（检查结果由调用方记录）。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { poll } from './v1-switch-helpers.mjs';

/** 后台进程退出时记忆页、工具卡、提示的悬停说明（§10.10） */
export const CRASHED = 'Mori’s background process crashed. Restart it to continue.';
/** 没有打开的会话时 Project 的悬停说明（§10.1） */
export const NO_PROJECT_HOVER = 'Open a session to see this project’s memory.';
/** 离开编辑的确认框（§10.1，标题临时） */
export const LEAVE_TITLE = 'Discard changes to this entry?';
export const LEAVE_TEXT = 'Your edits haven’t been saved. Leaving now discards them.';
/** AGENTS.md 合计的提醒线与超出时的说明（§10.3；2026-10-26 负责人走查 M15 由 500 改为 2000） */
export const AGENTS_LIMIT = 2000;
export const AGENTS_OVER = 'Over 2,000 tokens. Mori doesn’t shorten AGENTS.md; edit the files to keep prompts short.';
/** @brief 数字按千分位写（同界面的 thousands：token 数与合计 1000 起带逗号）。 */
export const thousands = (value) => value.toLocaleString('en-US');
/** 反馈表单的两种底部说明（§10.7） */
export const FEEDBACK_ON = 'Saved as evidence for this project’s daily enhancement. To have Mori act on it now, use '
  + '“Attach as context” instead.';
export const FEEDBACK_OFF = 'This project doesn’t have enhancement on, so feedback is only saved. To have Mori act on '
  + 'it, use “Attach as context” instead.';

/** 种类在界面与索引标题里的名字（§1、§3.1） */
export const KIND_LABEL = { fact: 'Facts', taste: 'TASTE', strategy: 'STRATEGY', review: 'REVIEW' };
/** 每种的索引文件（§3） */
export const INDEX_FILE = { fact: 'MEMORY.md', taste: 'TASTE.md', strategy: 'STRATEGY.md', review: 'REVIEW.md' };
/** 分节按钮的测试标识后缀与文字（§10.1、§10.11），按显示顺序 */
export const SECTIONS = [['facts', 'Facts'], ['taste', 'TASTE'], ['strategy', 'STRATEGY'], ['review', 'REVIEW'],
  ['agent', 'AGENT'], ['revisions', 'Revisions']];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------- §6.3 的估算（测试一侧照规格写） ----------

/** 中日韩字符：CJK 标点、平假名、片假名、扩展 A、统一表意文字、韩文音节、全角形式（§6.3） */
const CJK = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/u;

/** @brief §6.3：中日韩字符每个 1，其余字符数（按码点）÷ 4 向上取整，两部分相加。 */
export function estimate(text) {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** @brief 一层一种的用量（§6.3）：进 prompt 的行 `- <abstract>` 以 \n 连接后估算；没有条目时 0。 */
export function usageOf(abstracts) {
  return abstracts.length === 0 ? 0 : estimate(abstracts.map((abstract) => `- ${abstract}`).join('\n'));
}

/** @brief 一段只有 ASCII 字母与空格、不以空格开头结尾的文字，恰好 length 个字符（label 开头，各条不同）。 */
export function asciiText(label, length) {
  const words = `${label} keep the plan small and check each step before moving on `;
  let text = words.repeat(Math.ceil(length / words.length) + 1).slice(0, length);
  text = text.replace(/ $/, 'x');
  return text.replace(/^ /, 'x');
}

/**
 * @brief 一组 ASCII abstract（每条 ≤ 200 字符），它们的用量恰好是 tokens（行的总字符数恰好 4 × tokens）。
 * @param label 每条开头的文字（加序号，各条不同）
 */
export function abstractsFor(label, tokens) {
  const chars = tokens * 4;
  const count = Math.ceil((chars + 1) / 203);
  const lengths = Array.from({ length: count }, () => 200);
  let excess = count * 203 - 1 - chars;
  for (let at = count - 1; excess > 0 && at >= 0; at -= 1) {
    const cut = Math.min(excess, 180);
    lengths[at] -= cut;
    excess -= cut;
  }
  return lengths.map((length, index) => asciiText(`${label} ${String(index + 1).padStart(2, '0')}`, length));
}

// ---------- 日期（本地时间） ----------

/** @brief 两位补零。 */
export const pad2 = (n) => String(n).padStart(2, '0');

/** @brief 毫秒时刻 → 本地 `YYYY-MM-DD`。 */
export function localDate(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** @brief `YYYY-MM-DD` → `Oct 22`。 */
export function monthDay(day) {
  const [, , month, date] = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  return `${MONTHS[Number(month) - 1]} ${Number(date)}`;
}

/** @brief 毫秒时刻 → 本地 `Oct 22 04:00`。 */
export function monthDayTime(ms) {
  const date = new Date(ms);
  return `${MONTHS[date.getMonth()]} ${date.getDate()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** @brief 毫秒时刻 → 本地 `HH:MM`。 */
export function hhmm(ms) {
  const date = new Date(ms);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** @brief 带时区的本地 ISO 时刻（§3.3 的 time）。 */
export function localIso(ms) {
  const date = new Date(ms);
  const offset = -date.getTimezoneOffset();
  const zone = `${offset >= 0 ? '+' : '-'}${pad2(Math.floor(Math.abs(offset) / 60))}:${pad2(Math.abs(offset) % 60)}`;
  return `${localDate(ms)}T${hhmm(ms)}:${pad2(date.getSeconds())}.000${zone}`;
}

/** @brief 修订 id `<YYYYMMDD-HHmmss>-<4 位>`（§3.3，本地时间）。 */
export function revisionIdAt(ms, suffix) {
  const date = new Date(ms);
  return `${localDate(ms).replace(/-/g, '')}-${hhmm(ms).replace(':', '')}${pad2(date.getSeconds())}-${suffix}`;
}

/** @brief 日子加减（`YYYY-MM-DD`）。 */
export function addDays(day, n) {
  const [year, month, date] = day.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + n));
  return next.toISOString().slice(0, 10);
}

/** @brief §9.2：时刻属于的日子（time 为每天的时刻 `HH:MM`）。 */
export function dayOf(ms, time) {
  const day = localDate(ms);
  const [hours, minutes] = time.split(':').map(Number);
  const [year, month, date] = day.split('-').map(Number);
  return ms < new Date(year, month - 1, date, hours, minutes).getTime() ? addDays(day, -1) : day;
}

// ---------- 记忆文件（§3，synthetic test setup） ----------

/** @brief 项目目录名（§3：与 pi 的会话目录同一种编码）。 */
export const projectDirName = (cwd) => `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;

/** @brief 一层的目录：cwd 为 null 时是用户级 `memory/user`，否则是 `memory/projects/<编码>`。 */
export function layerDir(userData, cwd) {
  return cwd === null ? join(userData, 'memory', 'user') : join(userData, 'memory', 'projects', projectDirName(cwd));
}

/** @brief 测试准备（synthetic）：项目目录与 project.json（§3：记下工作目录原文）。 */
export function seedProject(userData, cwd) {
  const dir = layerDir(userData, cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify({ cwd: resolve(cwd) }, null, 2)}\n`);
  return dir;
}

/** @brief 依据行（§3.2，同 §10.1）。 */
export function evidenceLine(item) {
  const quote = item.quote ? `: “${item.quote}”` : '';
  if (item.feedback !== undefined) return `${monthDay(item.at)} · Feedback${quote}`;
  return `${monthDay(item.at)} · Session “${item.title ?? 'Untitled session'}”${quote}`;
}

/**
 * @brief 一个 detail 文件的全文（§3.2 的版式）。
 * @param entry { kind, abstract, source, created, modified, evidence?, details?, history? }
 */
export function detailText(entry) {
  const evidence = entry.evidence ?? [];
  const front = ['---', `kind: ${entry.kind}`, `abstract: ${JSON.stringify(entry.abstract)}`,
    `source: ${entry.source}`, `created: ${JSON.stringify(entry.created)}`,
    `modified: ${JSON.stringify(entry.modified)}`,
    `evidence: ${JSON.stringify(evidence)}`, '---'];
  const section = (heading, content) => (content ? `${heading}\n${content}` : heading);
  const body = [section('## Evidence', evidence.map((item) => `- ${evidenceLine(item)}`).join('\n')),
    section('## Details', entry.details ?? ''),
    section('## Revisions', (entry.history ?? []).map((line) => `- ${line}`).join('\n'))];
  return `${front.join('\n')}\n${body.join('\n\n')}\n`;
}

/** @brief 索引（§3.1）：`# <KIND>`，之后每条一行，链接文字里的 `]`、`\` 转义。 */
export function indexText(kind, items) {
  const lines = items.map((item) => `- [${item.abstract.replace(/[\\\]]/g, '\\$&')}](entries/${item.slug}.md)`);
  return `${[`# ${KIND_LABEL[kind]}`, ...lines].join('\n')}\n`;
}

/**
 * @brief 测试准备（synthetic）：写一层一种的条目与索引（§3.1、§3.2）。entries 每项 { slug, abstract, ... }，
 *        text 给出时原样写这个文件（读不出来的条目）。返回 slug → 写下的全文。
 */
export function seedKind(base, kind, entries) {
  mkdirSync(join(base, 'entries'), { recursive: true });
  const written = {};
  for (const entry of entries) {
    written[entry.slug] = entry.text ?? detailText({ kind, ...entry });
    writeFileSync(join(base, 'entries', `${entry.slug}.md`), written[entry.slug]);
  }
  writeFileSync(join(base, INDEX_FILE[kind]), indexText(kind, entries));
  return written;
}

/** @brief 修订里一份原文的围栏块（§3.3：至少四个波浪号，比原文里最长的纯波浪号行多一个）。 */
function fenced(label, text) {
  const longest = text.split('\n').filter((line) => /^~+$/.test(line))
    .reduce((most, line) => Math.max(most, line.length), 3);
  const fence = '~'.repeat(longest + 1);
  return text === '' ? `${fence}${label}\n${fence}` : `${fence}${label}\n${text}\n${fence}`;
}

/**
 * @brief 一次修订的全文（§3.3）。
 * @param rev { id, time, by, title, status, layers, kinds, counts, cwd, run, rollbackOf, changes, notes }；
 *            changes 每项 { head（`Added · TASTE · slug` 这样的小标题，不含 `## `）, evidence?, note?, before, after }
 */
export function revisionText(rev) {
  const json = JSON.stringify;
  const counts = { added: 0, changed: 0, deleted: 0, moved: 0, ...rev.counts };
  const front = ['---', `id: ${json(rev.id)}`, `time: ${json(rev.time)}`, `by: ${json(rev.by)}`,
    `title: ${json(rev.title)}`, `status: ${json(rev.status ?? 'done')}`, `layers: ${json(rev.layers)}`,
    `kinds: ${json(rev.kinds)}`, `counts: ${json(counts)}`, `cwd: ${json(rev.cwd ?? null)}`,
    `run: ${json(rev.run ?? null)}`, `rollbackOf: ${json(rev.rollbackOf ?? null)}`, '---'];
  const parts = (rev.changes ?? []).map((change) => [`## ${change.head}`,
    ...(change.evidence ? [`Evidence: ${change.evidence}`] : []), ...(change.note ? [`Note: ${change.note}`] : []),
    '', fenced('before', change.before), fenced('after', change.after)].join('\n'));
  if (rev.notes) parts.push(`## Notes\n${rev.notes}`);
  return `${front.join('\n')}\n${parts.length > 0 ? `${parts.join('\n\n')}\n` : ''}`;
}

/** @brief 测试准备（synthetic）：写一次修订到一层的 revisions/。 */
export function seedRevision(base, rev) {
  mkdirSync(join(base, 'revisions'), { recursive: true });
  writeFileSync(join(base, 'revisions', `${rev.id}.md`), revisionText(rev));
}

/**
 * @brief enhance.json 的内容（§9.1，synthetic test setup）：三个任务同样的 doneThrough，没有水位与上次结果。
 * @param opts { enabled, pick, thinking, time, since, doneThrough, notice }
 */
export function enhanceJson(opts) {
  const task = () => ({ doneThrough: opts.doneThrough ?? null, watermarks: {}, feedbackSeen: null, running: null,
    last: null });
  return { enabled: opts.enabled, pick: opts.pick ?? null, thinking: opts.thinking ?? null, team: false,
    time: opts.time, since: opts.since ?? null, tasks: { taste: task(), strategy: task(), review: task() },
    notice: opts.notice ?? null };
}

/** @brief 写一个项目的 enhance.json（synthetic test setup）。 */
export function seedEnhance(userData, cwd, content) {
  const dir = seedProject(userData, cwd);
  writeFileSync(join(dir, 'enhance.json'), `${JSON.stringify(content, null, 2)}\n`);
}

/** @brief 一层 revisions/ 下的修订 id（按名字排）。 */
export function revisionFiles(base) {
  const dir = join(base, 'revisions');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3))
    .sort() : [];
}

/** @brief 读一个文件；不存在时为 null。 */
export const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

/** @brief 一次修订文件 frontmatter 里某个键的原文（JSON），没有时为 null。 */
export function revisionField(base, id, key) {
  const text = readText(join(base, 'revisions', `${id}.md`)) ?? '';
  const line = text.split('\n').find((item) => item.startsWith(`${key}: `));
  return line ? JSON.parse(line.slice(key.length + 2)) : null;
}

/** @brief 一层一种的索引里的 slug（按顺序）。 */
export function indexSlugs(base, kind) {
  const text = readText(join(base, INDEX_FILE[kind])) ?? '';
  return [...text.matchAll(/^- \[(?:\\.|[^\\\]])*\]\(entries\/(.+)\.md\)\s*$/gm)].map((match) => match[1]);
}

/** @brief 一层的文件快照（索引、entries、revisions 的名字与内容），比较“什么都没写”。 */
export function layerSnapshot(base) {
  const files = {};
  for (const sub of ['', 'entries', 'revisions']) {
    const dir = join(base, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((item) => item.endsWith('.md'))) {
      files[join(sub, name)] = readFileSync(join(dir, name), 'utf8');
    }
  }
  return JSON.stringify(files);
}

// ---------- 读记忆页 ----------

/**
 * @brief 记忆页中栏此刻的样子：层、分节、项目文件夹名、用量、Last change、条目列表、读不出来的条目、Revisions 列表、
 *        列表位置的提示文字、AGENT、增强一块、内容区的滚动位置。页面不在时为 null。
 */
export function memoryState(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="memory-page"]');
    if (!root) return null;
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
    const control = (el) => el && { label: text(el), disabled: el.disabled, hover: el.getAttribute('title') ?? '',
      pressed: el.getAttribute('aria-pressed') };
    const sections = [...root.querySelectorAll('[data-testid^="memory-section-"]')].map((el) => ({
      id: el.dataset.testid.slice('memory-section-'.length), ...control(el) }));
    const usage = root.querySelector('[data-testid="memory-usage"]');
    const content = root.querySelector('.memory-content');
    const user = control(root.querySelector('[data-testid="memory-scope-user"]'));
    const project = control(root.querySelector('[data-testid="memory-scope-project"]'));
    return {
      user, project, scope: user?.pressed === 'true' ? 'user' : project?.pressed === 'true' ? 'project' : null,
      folder: text(root.querySelector('.memory-folder')), folderTitle: root.querySelector('.memory-folder')?.title,
      sections, section: sections.find((item) => item.pressed === 'true')?.id ?? null,
      usage: text(usage), usageOver: Boolean(usage?.querySelector('.memory-over')),
      last: control(root.querySelector('[data-testid="memory-last-change"]')),
      newEntry: control(root.querySelector('[data-testid="memory-new"]')),
      rows: [...root.querySelectorAll('[data-testid="memory-row"]')].map((el) => ({ id: el.dataset.id,
        source: el.dataset.source, title: text(el.querySelector('.memory-row-title')),
        meta: [...el.querySelectorAll('.memory-row-meta > span')].map(text), ...control(el) })),
      broken: [...root.querySelectorAll('[data-testid="memory-broken"]')].map((el) => ({ name: el.dataset.name,
        title: text(el.querySelector('.memory-row-title')), error: text(el.querySelector('.memory-row-error')),
        tag: el.tagName, buttons: el.querySelectorAll('button').length })),
      revisions: [...root.querySelectorAll('[data-testid="revision-row"]')].map((el) => ({ id: el.dataset.id,
        title: text(el.querySelector('.memory-row-title')),
        meta: [...el.querySelectorAll('.memory-row-meta > span')].map(text),
        tags: [...el.querySelectorAll('.memory-tag')].map(text), ...control(el) })),
      states: [...(content?.querySelectorAll('.memory-state') ?? [])].map(text),
      loadError: text(root.querySelector('.memory-load-error')),
      reading: Boolean(root.querySelector('.memory-reading')),
      agentFiles: [...root.querySelectorAll('[data-testid="memory-agent-file"]')].map((el) => ({
        path: text(el.querySelector('.memory-agent-path')), tokens: text(el.querySelector('.memory-agent-tokens')),
        none: text(el.querySelector('.memory-agent-none')),
        buttons: [...el.querySelectorAll('button')].map(control) })),
      agentTotal: text(root.querySelector('[data-testid="memory-agent-total"]')),
      agentTotalOver: Boolean(root.querySelector('[data-testid="memory-agent-total"].memory-over')),
      enhance: Boolean(root.querySelector('[data-testid="memory-enhance"]')),
      enhanceControls: ['enhance-switch', 'enhance-run', 'enhance-settings']
        .map((id) => ({ id, ...control(root.querySelector(`[data-testid="${id}"]`)) })),
      enhanceStatus: text(root.querySelector('[data-testid="enhance-status"]')),
      back: control([...root.querySelectorAll('.topbar button')].find((el) => el.textContent.includes('Back to app'))),
      banners: root.querySelectorAll('.banner, [data-testid="kernel-exit"]').length,
      scrollTop: content?.scrollTop ?? null,
    };
  });
}

/** @brief 右栏的修订详情（Revisions 节）：标题、时间与谁、Day 一行、每处改动（含对照的文字）、Notes、回滚；没有时为 null。 */
function revisionPanel(page) {
  return page.evaluate(() => {
    const rev = document.querySelector('[data-testid="memory-detail"] [data-testid="revision-detail"]');
    if (!rev) return null;
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
    const control = (el) => el && { label: text(el), disabled: el.disabled, hover: el.getAttribute('title') ?? '' };
    // 对照由 @pierre/diffs 画在 shadow DOM 里（textContent 读不到），连 shadowRoot 一起走
    const deep = (node) => {
      let out = '';
      const walk = (item) => {
        if (item.nodeType === 3) out += item.textContent;
        if (item.shadowRoot) walk(item.shadowRoot);
        for (const child of item.childNodes) walk(child);
      };
      if (node) walk(node);
      return out;
    };
    const notes = [...rev.querySelectorAll('.memory-block')]
      .find((block) => text(block.querySelector('.memory-label')) === 'Notes');
    return { title: text(rev.querySelector('.memory-detail-title')),
      metas: [...rev.querySelectorAll('.memory-detail-meta')].map(text),
      changes: [...rev.querySelectorAll('details.memory-change')].map((change) => ({
        title: text(change.querySelector('summary')), notes: [...change.querySelectorAll('.memory-change-note')]
          .map(text), diff: deep(change.querySelector('.memory-diff')) })),
      notes: text(notes?.querySelector('.memory-details')),
      rollback: control(rev.querySelector('[data-testid="revision-rollback"]')),
      error: text(rev.querySelector('[data-testid="memory-error"]')),
      loading: !rev.querySelector('.memory-detail-title') };
  });
}

/** @brief 右栏的条目详情、表单与写入失败的提示；右栏不在时为 null。 */
function entryPanel(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-testid="memory-detail"]');
    if (!panel) return null;
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
    const control = (el) => el && { label: text(el), disabled: el.disabled, hover: el.getAttribute('title') ?? '' };
    const all = (root, css) => [...(root?.querySelectorAll(css) ?? [])];
    const entry = panel.querySelector('.memory-entry');
    const details = all(entry, '.memory-block').find((block) => text(block.querySelector('.memory-label'))
      === 'Details');
    const history = entry?.querySelector('[data-testid="memory-history"]');
    const backlinks = entry?.querySelector('[data-testid="memory-backlinks"]');
    const form = panel.querySelector('[data-testid="memory-form"]');
    return {
      loading: all(panel, '.memory-state').some((el) => el.textContent.includes('Loading')),
      error: text(panel.querySelector('[data-testid="memory-error"]')),
      loadError: text(panel.querySelector('.memory-load-error')),
      title: text(entry?.querySelector('.memory-detail-title')),
      meta: text(entry?.querySelector('.memory-detail-meta')),
      evidence: all(entry, '.memory-evidence-item').map((item) => ({
        line: text(item.querySelector('.memory-evidence-line')),
        jump: control(item.querySelector('[data-testid="memory-jump"]')),
        status: text(item.querySelector('[data-testid="memory-jump-status"]')) })),
      noEvidence: text(entry?.querySelector('[data-testid="memory-evidence"] .memory-muted')),
      details: text(details?.querySelector('.memory-details')),
      links: all(details, 'button.memory-link').map(control), missing: all(details, '.memory-link-missing').map(text),
      backlinks: backlinks ? all(backlinks, 'button').map(control) : null,
      history: history ? { lines: all(history, '.memory-history-lines li').map(text),
        revisions: all(history, '.memory-links li').map((li) => ({ ...control(li.querySelector('button')),
          line: text(li) })) } : null,
      actions: Object.fromEntries(['edit', 'delete', 'move'].map((id) => [id,
        control(panel.querySelector(`[data-testid="memory-${id}"]`))])),
      form: form ? { abstract: form.querySelector('[data-testid="memory-abstract"]')?.value,
        details: form.querySelector('[data-testid="memory-details"]')?.value, errors: all(form, '.field-error')
          .map(text), save: control(form.querySelector('[data-testid="memory-save"]')), noValidate: form.noValidate }
        : null,
    };
  });
}

/**
 * @brief 记忆页右栏此刻的样子：读取中、写入失败的提示、条目详情的各块（标题、来历、Evidence、Details 与链接、
 *        Linked from、History、操作）、表单，以及修订详情（revision）。右栏不在时为 null。
 */
export async function detailState(page) {
  const entry = await entryPanel(page);
  return entry && { ...entry, revision: await revisionPanel(page) };
}

// ---------- 操作 ----------

/** @brief 等记忆页的中栏读完：内容区没有 `Loading…`，标题旁也没有。 */
export function waitLoaded(page, timeout = 20000) {
  return page.waitForFunction(() => {
    const root = document.querySelector('[data-testid="memory-page"]');
    if (!root || root.querySelector('.memory-reading')) return false;
    const content = root.querySelector('.memory-content');
    return Boolean(content) && ![...content.querySelectorAll('.memory-state')]
      .some((el) => el.textContent.includes('Loading'));
  }, null, { timeout });
}

/** @brief 等右栏读完（条目、表单、修订或读取失败）；right 为 false 时等右栏关闭。 */
export function waitDetail(page, open = true, timeout = 20000) {
  return page.waitForFunction((want) => {
    const panel = document.querySelector('[data-testid="memory-detail"]');
    if (!want) return !panel;
    return Boolean(panel?.querySelector('.memory-entry, [data-testid="memory-form"], .memory-load-error, '
      + '[data-testid="revision-detail"] .memory-detail-title'));
  }, open, { timeout });
}

/** @brief 点左栏 Memory，等记忆页出现并读完。 */
export async function openMemoryPage(page) {
  await page.getByTestId('nav-memory').click();
  await page.getByTestId('memory-page').waitFor({ timeout: 15000 });
  await waitLoaded(page);
}

/** @brief 记忆页的 Back to app，等回到对话（记忆页不在）。 */
export async function backToApp(page) {
  await page.locator('[data-testid="memory-page"] .topbar button', { hasText: 'Back to app' }).click();
  await page.getByTestId('memory-page').waitFor({ state: 'detached', timeout: 10000 });
}

/** @brief 换层（User / Project），等读完。 */
export async function chooseScope(page, scope) {
  await page.getByTestId(`memory-scope-${scope}`).click();
  await page.waitForFunction((id) => document.querySelector(`[data-testid="memory-scope-${id}"]`)
    ?.getAttribute('aria-pressed') === 'true', scope, { timeout: 10000 });
  await waitLoaded(page);
}

/** @brief 换分节（facts、taste、strategy、review、agent、revisions），等读完。 */
export async function chooseSection(page, id) {
  await page.getByTestId(`memory-section-${id}`).click();
  await page.waitForFunction((section) => document.querySelector(`[data-testid="memory-section-${section}"]`)
    ?.getAttribute('aria-pressed') === 'true', id, { timeout: 10000 });
  await waitLoaded(page);
}

/** @brief 打开记忆页，到 scope 层的 section 分节（等读完）。 */
export async function goMemory(page, scope, section) {
  if (!(await page.getByTestId('memory-page').count())) await openMemoryPage(page);
  const state = await memoryState(page);
  if (state.scope !== scope) await chooseScope(page, scope);
  if ((await memoryState(page)).section !== section) await chooseSection(page, section);
}

/** @brief 点列表里的一条（data-id），等它的详情出现。 */
export async function selectRow(page, id) {
  await page.locator(`[data-testid="memory-row"][data-id="${id}"]`).click();
  await page.waitForFunction((slug) => document.querySelector(`[data-testid="memory-row"][data-id="${slug}"]`)
    ?.getAttribute('aria-pressed') === 'true', id, { timeout: 10000 });
  await waitDetail(page);
}

/** @brief 点 Revisions 列表里的一行（data-id），等修订详情出现。 */
export async function selectRevisionRow(page, id) {
  await page.locator(`[data-testid="revision-row"][data-id="${id}"]`).click();
  await page.waitForFunction((rev) => document.querySelector(`[data-testid="revision-row"][data-id="${rev}"]`)
    ?.getAttribute('aria-pressed') === 'true', id, { timeout: 10000 });
  await waitDetail(page);
}

/** @brief 等列表里出现（want 为 true）或不再有（false）某条（data-id）。 */
export async function waitRow(page, id, want = true, timeout = 15000) {
  return poll(async () => {
    const state = await memoryState(page);
    return Boolean(state) && state.rows.some((row) => row.id === id) === want && !state.reading;
  }, timeout, 100);
}

/** @brief 填表单（不给的字段不碰）。 */
export async function fillForm(page, { abstract, details }) {
  const form = page.getByTestId('memory-form');
  if (abstract !== undefined) await form.getByTestId('memory-abstract').fill(abstract);
  if (details !== undefined) await form.getByTestId('memory-details').fill(details);
}

/**
 * @brief 点表单的 Save，等结果：表单关闭（成功）、详情顶部出现写入失败的提示、或字段下方出现问题（最多 timeout）。
 * @return 'saved' | 'error' | 'field' | 'timeout'
 */
export async function saveForm(page, timeout = 15000) {
  await page.getByTestId('memory-save').click();
  const outcome = await poll(() => page.evaluate(() => {
    const panel = document.querySelector('[data-testid="memory-detail"]');
    if (!panel?.querySelector('[data-testid="memory-form"]')) return 'saved';
    if (panel.querySelector('[data-testid="memory-error"]')) return 'error';
    return panel.querySelector('.field-error') ? 'field' : null;
  }), timeout, 100);
  if (outcome === 'saved') await waitDetail(page);
  return outcome ?? 'timeout';
}

/** @brief New entry：填表单并保存；返回 saveForm 的结果。 */
export async function newEntry(page, abstract, details = '') {
  await page.getByTestId('memory-new').click();
  await page.getByTestId('memory-form').waitFor({ timeout: 10000 });
  await fillForm(page, { abstract, details });
  return saveForm(page);
}

/** @brief 删除右栏的条目（Delete… → 确认框的 Delete），等确认框关闭。 */
export async function deleteOpenEntry(page) {
  await page.getByTestId('memory-delete').click();
  const dialog = page.getByTestId('memory-delete-dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
}

/** @brief 点 Move to user level / Move to this project，等结果：右栏关闭（成功）或写入失败的提示。 */
export async function moveOpenEntry(page, timeout = 15000) {
  await page.getByTestId('memory-move').click();
  return poll(() => page.evaluate(() => {
    const panel = document.querySelector('[data-testid="memory-detail"]');
    if (!panel) return 'moved';
    return panel.querySelector('[data-testid="memory-error"]') ? 'error' : null;
  }), timeout, 100).then((value) => value ?? 'timeout');
}

/**
 * @brief 在 Revisions 节点右栏的 Roll back this revision，等结果：列表最上面出现 `Rolled back: <title>`（成功）或
 *        按钮旁边出现失败的提示。
 * @param title 被回滚的那次修订的标题
 * @return 'done' | 'error' | 'timeout'
 */
export async function rollbackOpenRevision(page, title, timeout = 15000) {
  await page.getByTestId('revision-rollback').click();
  const outcome = await poll(() => page.evaluate((wanted) => {
    const rev = document.querySelector('[data-testid="revision-detail"]');
    if (rev?.querySelector('[data-testid="memory-error"]')) return 'error';
    const first = document.querySelector('[data-testid="revision-row"] .memory-row-title')?.textContent;
    return first === `Rolled back: ${wanted}` ? 'done' : null;
  }, title), timeout, 100);
  if (outcome === 'done') await waitLoaded(page);
  return outcome ?? 'timeout';
}

/** @brief Revisions 列表里标题为 title 的第一行（最新的）的 id；没有时为 null。 */
export async function revisionRowId(page, title) {
  return (await memoryState(page))?.revisions.find((row) => row.title === title)?.id ?? null;
}

/**
 * @brief 在页面里装一个 MutationObserver：记下记忆页的列表有没有消失过（memory-list 不在）、标题旁的 Loading…
 *        有没有出现过。window.__memWatch = { listGone, reading }。
 */
export function watchList(page) {
  return page.evaluate(() => {
    window.__memWatch?.observer.disconnect();
    const watch = { listGone: false, reading: false, observer: null };
    watch.observer = new MutationObserver(() => {
      if (!document.querySelector('[data-testid="memory-list"]')) watch.listGone = true;
      if (document.querySelector('.memory-reading')) watch.reading = true;
    });
    watch.observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    window.__memWatch = watch;
  });
}

/** @brief watchList 记下的结果，并停止观察。 */
export function watched(page) {
  return page.evaluate(() => {
    const watch = window.__memWatch;
    watch?.observer.disconnect();
    return { listGone: watch?.listGone ?? null, reading: watch?.reading ?? null };
  });
}
