// 上下文用量圆环详情里的分项（docs/v0/screens/models.md"详情里的分项"，2026-10-26 WP-12）：在页面里量分项的各行、
// 分段条和圆环的读屏描述，在 Node 里按状态表核对名字、顺序、写法、颜色和数是怎样加起来的。m1-app、m6-app-row、
// m1-replay 共用；各套件自己的 ringState 不变。

/** 分项的键（data-part）和 Claude 的名字，按固定顺序（Claude Code /context 的顺序） */
export const PART_NAMES = {
  systemPrompt: 'System prompt', systemTools: 'System tools', mcpTools: 'MCP tools', memoryFiles: 'Memory files',
  skills: 'Skills', messages: 'Messages', autocompactBuffer: 'Autocompact buffer', freeSpace: 'Free space',
};
const PART_ORDER = Object.keys(PART_NAMES);
/** 系统提示词与工具说明的五项（Messages 是 tokens 减去它们） */
const FIXED = ['systemPrompt', 'systemTools', 'mcpTools', 'memoryFiles', 'skills'];
/** 各分项的颜色 token（defaults.md"上下文分项的颜色"） */
const PART_COLORS = {
  systemPrompt: '--color-part-prompt', systemTools: '--color-part-tools', mcpTools: '--color-part-mcp',
  memoryFiles: '--color-part-memory', skills: '--color-part-skills', messages: '--color-part-messages',
  autocompactBuffer: '--color-faint', freeSpace: '--color-line',
};

/** @brief 照 models.md 的写法缩短一个数（测试自己算）：k、M 一位小数去掉".0"，999,950 起写成 M。 */
function shortCount(count) {
  const trim = (text) => text.replace(/\.0$/, '');
  if (count < 1000) return String(count);
  if (count < 999_950) return `${trim((count / 1000).toFixed(1))}k`;
  return `${trim((count / 1_000_000).toFixed(1))}M`;
}

/**
 * @brief 量 scope 那一栏（.pane-slot 或会话面板的选择器）的圆环详情里的分项：圆环的 data-tokens、读屏的描述、
 *        每行（data-part、data-tokens、名字、数、百分比、色块的底色）、分段条每段（data-part、底色、宽、
 *        flex-grow，即这一段按多少 token 占比）、段与段之间的空白、详情里能停焦点的元素个数、各颜色 token 算出来的底色。
 *        没有圆环时为 null；详情没开时 rows 为空。
 */
export function readParts(page, scope, colors = PART_COLORS) {
  return page.evaluate(({ css, tokens }) => {
    const ring = document.querySelector(`${css} [data-testid="usage"]`);
    if (!ring) return null;
    const pane = ring.closest('[data-testid="chat-pane"]') ?? document;
    const details = pane.querySelector('[data-testid="usage-details"]');
    const text = (el, sel) => el.querySelector(sel)?.textContent ?? null;
    const background = (el) => (el ? getComputedStyle(el).backgroundColor : null);
    const rows = [...(details?.querySelectorAll('[data-testid="usage-part"]') ?? [])].map((row) => ({
      part: row.dataset.part, tokens: Number(row.dataset.tokens), name: text(row, '.usage-part-name'),
      count: text(row, '.usage-part-count'), percent: text(row, '.usage-part-percent'),
      swatch: background(row.querySelector('.usage-swatch')) }));
    const boxes = [...(details?.querySelectorAll('[data-testid="usage-segment"]') ?? [])]
      .map((el) => ({ el, box: el.getBoundingClientRect() }));
    const segments = boxes.map(({ el, box }) => ({ part: el.dataset.part, color: background(el), width: box.width,
      height: box.height, grow: Number(el.style.flexGrow) }));
    const gaps = boxes.slice(1).map(({ box }, i) => box.left - boxes[i].box.right);
    const desc = (ring.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    const probe = document.createElement('span');
    document.body.append(probe);
    const palette = Object.fromEntries(Object.entries(tokens).map(([part, name]) => {
      probe.style.backgroundColor = `var(${name})`;
      return [part, getComputedStyle(probe).backgroundColor];
    }));
    probe.remove();
    const focusables = details ? details.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')
      .length : 0;
    return { tokens: ring.getAttribute('data-tokens'), state: ring.dataset.state ?? null, desc, rows, segments, gaps,
      focusables, palette, open: Boolean(details) };
  }, { css: scope, tokens: colors });
}

/** @brief 一行的数应有的写法：Autocompact buffer 是设置的值，不加"≈ "。 */
const countText = (row) => (row.part === 'autocompactBuffer' ? '' : '≈ ') + shortCount(row.tokens);
/** @brief 一行读屏描述应有的写法。 */
const readText = (row, percent) => `${row.name} ${row.part === 'autocompactBuffer' ? '' : 'approximately '}`
  + `${row.tokens.toLocaleString('en-US')} tokens (${percent})`;

/** @brief 每一行的名字、顺序、不为 0、数和百分比的写法、色块的颜色。 */
function rowProblems(seen, window) {
  const out = [];
  const order = seen.rows.map((row) => PART_ORDER.indexOf(row.part));
  if (order.some((n, i) => n < 0 || (i > 0 && n <= order[i - 1]))) {
    out.push(`order ${seen.rows.map((row) => row.part).join(',')}`);
  }
  for (const row of seen.rows) {
    const percent = `${((row.tokens / window) * 100).toFixed(1)}%`;
    if (row.name !== PART_NAMES[row.part]) out.push(`${row.part}: name "${row.name}"`);
    if (!(row.tokens > 0)) out.push(`${row.part}: shown with ${row.tokens} tokens`);
    if (row.count !== countText(row)) out.push(`${row.part}: count "${row.count}" ≠ "${countText(row)}"`);
    if (row.percent !== percent) out.push(`${row.part}: percent "${row.percent}" ≠ "${percent}"`);
    const color = seen.palette[row.part];
    if (row.swatch !== color) out.push(`${row.part}: swatch ${row.swatch} ≠ ${color}`);
  }
  return out;
}

/** @brief 数是怎样加起来的：Messages = tokens − 五项（不小于 0），buffer = reserve，Free space = 窗口 − tokens − buffer。 */
function sumProblems(seen, { window, reserve }) {
  const out = [];
  const of = (part) => seen.rows.find((row) => row.part === part)?.tokens ?? 0;
  const tokens = Number(seen.tokens);
  const fixed = FIXED.reduce((sum, part) => sum + of(part), 0);
  if (of('messages') !== Math.max(0, tokens - fixed)) out.push(`Messages ${of('messages')} for ${tokens} − ${fixed}`);
  const buffer = seen.rows.find((row) => row.part === 'autocompactBuffer')?.tokens ?? null;
  if (buffer !== reserve) out.push(`Autocompact buffer ${buffer}, want ${reserve}`);
  const free = Math.max(0, window - tokens - (reserve ?? 0));
  if (of('freeSpace') !== free) out.push(`Free space ${of('freeSpace')}, want ${free}`);
  return out;
}

/** @brief 分段条：段的顺序同各行、颜色同色块、4px 高、至少 2px 宽、段间 2px；读屏的描述；详情里没有能停焦点的东西。 */
function barProblems(seen) {
  const out = [];
  const parts = seen.rows.map((row) => row.part).join(',');
  if (seen.segments.map((seg) => seg.part).join(',') !== parts) {
    out.push(`segments ${seen.segments.map((seg) => seg.part).join(',')} ≠ rows ${parts}`);
  }
  for (const seg of seen.segments) {
    if (seg.color !== seen.palette[seg.part]) out.push(`segment ${seg.part}: ${seg.color} ≠ ${seen.palette[seg.part]}`);
    if (Math.abs(seg.height - 4) > 0.6 || seg.width < 1.5) out.push(`segment ${seg.part}: ${seg.width}×${seg.height}`);
  }
  if (seen.gaps.some((gap) => Math.abs(gap - 2) > 0.6)) out.push(`gaps ${seen.gaps.map((gap) => gap.toFixed(1))}`);
  const desc = seen.rows.map((row) => readText(row, row.percent)).join(', ');
  if (seen.desc !== desc) out.push(`description "${seen.desc}" ≠ "${desc}"`);
  if (seen.desc.includes('/')) out.push('"/" in the description');
  if (seen.focusables > 0) out.push(`${seen.focusables} focus stops in the details`);
  return out;
}

/**
 * @brief 有用量时详情里的分项不符合状态表的地方（空表示符合）。
 * @param seen readParts 的结果（详情开着）
 * @param options.window 第一行的窗口
 * @param options.reserve pi 自动压缩留出的 token 数；关掉了自动压缩时为 null（没有"Autocompact buffer"一行）
 * @param options.has 必须有的分项（键）
 * @param options.lacks 必须没有的分项（键）
 */
export function partsProblems(seen, { window, reserve, has = [], lacks = [] }) {
  if (!seen?.open) return ['details not open'];
  if (seen.state !== 'used') return [`state ${seen.state}`];
  const shown = new Set(seen.rows.map((row) => row.part));
  return [...rowProblems(seen, window), ...sumProblems(seen, { window, reserve }), ...barProblems(seen),
    ...has.filter((part) => !shown.has(part)).map((part) => `no ${PART_NAMES[part]} row`),
    ...lacks.filter((part) => shown.has(part)).map((part) => `has a ${PART_NAMES[part]} row`)];
}

/**
 * @brief 一组分项里看得见的全部内容（比较两次读到的是不是同一组）：各行的 data-part、data-tokens、名字、数、百分比，
 *        分段条各段的 data-part 与 flex-grow，圆环的读屏描述。没有读到时为 null。
 */
export const partsDigest = (seen) => (seen ? JSON.stringify({
  rows: seen.rows.map((row) => [row.part, row.tokens, row.name, row.count, row.percent]),
  segments: seen.segments.map((seg) => [seg.part, seg.grow]), desc: seen.desc.trim() }) : null);

/** @brief 一组分项的简短写法（记进检查的说明）。 */
export const partsBrief = (seen) => (seen?.rows ?? []).map((row) => `${row.name} ${row.tokens} ${row.percent}`)
  .join(' | ');
