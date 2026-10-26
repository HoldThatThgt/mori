// 记忆规格的 App 套件：身份与 harness 段、四个分节、分发表、会话打开时定下、记忆页的条目进 prompt、协作模式下谁有
// memory 工具、记忆目录的写保护、必需的记忆扩展（docs/specs/memory.md §4、§5、§7.6、§7.7、§14.2）。
// 真正的 Mori（界面 + 后台进程 + pi + 主进程）对合成端点（tests/fake-endpoint/server.mjs，synthetic：脚本模式的
// scenarios/mem-prompt.mjs、增强脚本 enhance.mjs、关键词模式），逐条验收这些编号在 App 层的通过条件：
//   MEM-01 身份与 harness 段、MEM-02 四个分节、MEM-03 分发表、MEM-04 会话打开时定下、MEM-05 记忆页的条目进 prompt、
//   MEM-11 协作模式下谁有工具、MEM-13 记忆目录写保护、MEM-37 必需的记忆扩展。
// 另借 split 步骤查 docs/v0/screens/tools.md"内置工具"列表一行的两条（名字以 M12 开头，不属于记忆规格；2026-10-26 补，
// WP-08 的状态表各行的用例）：分开配置的用户会话只列 3 个 TaskBoard 工具，"Enabled"到下一条消息才随 Task mode 变。
// 断言看两处：记录代理收到的真实请求（system prompt 与 tools 参数，tb-helpers startTbEndpoint / scenarioRequests），
// 以及会话文件（pi-ai 的 getCurrentSystemMessage 读回会话当前的分节，§11.2 M7）。
// 用法（在 app/ 下，用 out/ 的构建，或 MORI_APP_DIR 指向的构建）：
//   node tests/ui/mem-app-prompt.mjs [--exe <Mori.exe>] [--only 步骤1,步骤2]
// 结果写到 test-results/mem-app-prompt(-packaged).json（--only 时 mem-partial-app-prompt…，不计入覆盖检查），
// 截图与 app.log 在 test-results/mem-app-prompt/。
// 端口（§14.1 的 4700–4799 里分给本套件的 4700–4709）：合成端点 4700，记录代理 4701。
// 测试准备（synthetic test setup，逐处注明）：数据目录里一个本机提供商 mpa（写入等级 A，跳过探针）；用户级 SYSTEM.md；
// 按 §3 的格式写好的记忆文件（用户级、两个项目的条目，以及读不出来的两条）；七个临时项目（没有角色文件、分开配置、
// chat.md 写 tools: [read]、带受信任的 .pi/SYSTEM.md、写保护、角色文件有问题、增强）。
// MEM-37 用当前构建（out/ 或 MORI_APP_DIR）的一份拷贝（.tb-runs/mem-memfail），只在拷贝的内核代码里让 mori-memory 的
// 工厂函数抛错（synthetic fault injection，同 tb-app-roles 的 TB-43；本构建与 src 不变），最后单独启动。

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MEM_PROMPT_ROLES, MEM_PROMPT_TEXT, mergedAgentsMd } from '../fake-endpoint/scenarios/mem-prompt.mjs';
import { appRoot, arg } from './lib.mjs';
import { stubFolder } from './m3-helpers.mjs';
import { openToolsSection } from './m6-helpers.mjs';
import { TOOL_REASONS, toolRows } from './m6-tools-helpers.mjs';
import {
  appLogLines, bridge, brief, clickTeamSwitch, closeTbApp, contentText, expectedHandoff, instanceFiles, messagesOf,
  missingSteps,
  newSession, openProject, paneSel, poll, readJsonl, reopenSession, restartTbApp, scenarioRequests, seedTeamUserData,
  sendMessage, shot, showTab, sleep, startTbApp, startTbEndpoint, stopTbEndpoint, tbModel, tbProvider, tbRecorder,
  teamSwitch, tempProject, tempUserData, userSession, waitTeamIdle, writeRole, writeRoles,
} from './tb-helpers.mjs';

// ---------- 命令行与结果文件 ----------

/** @brief 本套件的命令行（同 tb-helpers suiteArgs 的 --exe、--only），结果文件按记忆规格 §14.3 的 mem- 前缀。 */
function memArgs() {
  const exePath = arg('exe') ? resolve(arg('exe')) : null;
  const only = arg('only')?.split(',').filter(Boolean) ?? null;
  const packaged = exePath ? '-packaged' : '';
  const file = only ? `mem-partial-app-prompt${packaged}.json` : `mem-app-prompt${packaged}.json`;
  const shots = join(appRoot, `test-results/mem-app-prompt${packaged}`);
  mkdirSync(shots, { recursive: true });
  return { suite: 'mem-app-prompt', exePath, only, file, shots };
}

const args = memArgs();
const { record, finish } = tbRecorder(args);

/** 本套件的端口：合成端点与它前面的记录代理 */
const PORT = 4700;
const PROXY = 4701;
/** 合成端点上的模型（synthetic） */
const MODEL = 'fake-mem-prompt';

// ---------- 规格里的文字 ----------

/** 附录 A.1（IDENTITY_TEXT），逐字 */
const IDENTITY_TEXT = [
  "You are Mori, a coding assistant working in the user's project folder. You read files, run commands, edit code "
    + "and write files to get the user's work done.",
  "Tool calls other than reading and searching may wait for the user's approval. A denied call returns the user's "
    + "reason as its result: follow it and don't repeat the call.",
  'The sections after the project information hold what Mori has learned with this user: <taste> how to talk with '
    + 'the user, <strategy> how to size and plan work, <review> what to check before saying work is done, <facts> '
    + 'what is true about the user and this project. Follow them unless the user says otherwise.',
].join('\n');
/** 有它们之一时身份段带附录 A.1.1 那一句（§4.1；那一句按有的工具拼，tb-helpers expectedHandoff） */
const HANDOFF_TOOLS = ['task_create', 'agent_message', 'subagent'];
/** 身份段里 <tools> 的开头（§4.1：IDENTITY_TEXT［加 A.1.1］之后空一行是 <tools>） */
const TOOLS_OPEN = '\n\n<tools>\n';

/**
 * @brief 身份段的开头：IDENTITY_TEXT，没有交出去的活那一句时直接空一行 <tools>，有时中间一个空格加那一句。
 * @return { handoff（那一句；没有时为 null）, length（到 <tools> 的内容开始的长度） }；不是这样开头时为 null
 */
function identityHead(text) {
  if (typeof text !== 'string' || !text.startsWith(IDENTITY_TEXT)) return null;
  const at = text.indexOf(TOOLS_OPEN, IDENTITY_TEXT.length);
  if (at < 0) return null;
  const between = text.slice(IDENTITY_TEXT.length, at);
  if (between !== '' && (!between.startsWith(' ') || between.includes('\n'))) return null;
  return { handoff: between === '' ? null : between.slice(1), length: at + TOOLS_OPEN.length };
}
const TOOLS_TO_RULES = '\n</tools>\n\n<rules>\n';
const RULES_END = '\n</rules>';
/** pi 自己的身份句与文档指引（§4.1：不出现） */
const PI_IDENTITY = 'You are an expert coding assistant operating inside pi';
const PI_DOCS = 'Pi documentation';
/** <tools> 的最后一行（pi system-prompt.js:86） */
const TOOLS_LAST = 'In addition to the tools above, you may have access to other custom tools depending on the '
  + 'project.';
/** pi 的内置工具（有 promptSnippet 的；TaskBoard 工具与 memory 没有，§7.1） */
const BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'powershell'];
/** pi buildRules 的 shell 规则三种与固定的最后两条（§4.1） */
const SHELL_RULE = {
  bash: 'Use bash for file operations like ls, rg, find',
  powershell: 'Use PowerShell for file operations like listing, searching, and finding files',
  both: 'Use bash or PowerShell for file operations like listing, searching, and finding files',
};
const FIXED_RULES = ['- Be concise in your responses', '- Show file paths clearly when working with files'];
/** §6.3 的上限（身份段在默认工具下也按它量，§4.4） */
const LIMIT = 500;
/** §5.2 四个分节的名字，按写入顺序；种类 → 分节名 */
const MEMORY_KINDS = ['taste', 'strategy', 'review', 'fact'];
const SECTION_OF = { taste: 'taste', strategy: 'strategy', review: 'review', fact: 'facts' };
const MEMORY_SECTIONS = MEMORY_KINDS.map((kind) => SECTION_OF[kind]);
/** §5.1 分发表：身份 → 拿哪几种 */
const SEAT_KINDS = {
  main: ['taste', 'strategy', 'review', 'fact'],
  dialog: ['taste'],
  merged: ['taste', 'strategy', 'fact'],
  create: ['taste', 'strategy', 'fact'],
  close: ['review'],
  sub: ['strategy', 'review'],
};
/** 合成端点认出的会话种类（scripts.mjs kindOf）→ §5.1 的身份 */
const SEAT_OF_KIND = { dialog: 'main', 'off-dialog': 'main', 'team-dialog': 'dialog', 'merged-create': 'merged',
  create: 'create', close: 'close', task: 'sub', ask: 'sub', subscription: 'sub' };
/** 实例会话 mori.instance 的 kind → 身份 */
const SEAT_OF_INSTANCE = { create: 'create', close: 'close', task: 'sub', ask: 'sub', subscription: 'sub' };
/** §7.6 分开配置时对话的 memory 不启用，pi 在 tool_call 处理器之前按不在启用的工具里拒绝（同 TB-09 的 bash） */
const MEMORY_NOT_FOUND = 'Tool memory not found';
/** §7.7 的拒绝原文 */
const MEMORY_FILES_ONLY = 'Memory files can only be changed with the memory tool or on the Memory page.';
/** §4.3 的日志 */
const SYSTEM_LOG = '[kernel] SYSTEM.md is not used: ';
/** 增强会话第一条消息的第一句开头（附录 B） */
const ENHANCE_FIRST = "You are running Mori's daily ";

// ---------- 测试准备的数据（synthetic test setup） ----------

/** SYSTEM.md 里的标记：不该出现在任何请求里（§4.3） */
const USER_SYSTEM_MARK = 'MORI-SYSTEM-USER-MD';
const PROJECT_SYSTEM_MARK = 'MORI-SYSTEM-PROJECT-MD';
/** 用户级条目（synthetic）：没有 REVIEW，没有本项目条目的项目里就没有 review 这一段 */
const USER_MEMORY = {
  fact: ['MEMU-FACT-1 The user works in the Asia/Shanghai time zone'],
  taste: ['MEMU-TASTE-1 Keep answers short', 'MEMU-TASTE-2 Use plain words, no jargon'],
  strategy: ['MEMU-STRAT-1 Plan before changing more than three modules'],
  review: [],
};
/** 没有角色文件的项目的条目（synthetic）：STRATEGY 只有读不出来的两条 */
const PLAIN_MEMORY = {
  fact: ['MEMP-PLAIN-FACT-1 The fixture project has one source file'],
  taste: ['MEMP-PLAIN-TASTE-1 Show the file path before the code'],
  strategy: [],
  review: ['MEMP-PLAIN-REVIEW-1 Run the tests before saying done'],
};
/** 分开配置的项目的条目（synthetic）：四种都有 */
const SPLIT_MEMORY = {
  fact: ['MEMP-SPLIT-FACT-1 The split project uses role files'],
  taste: ['MEMP-SPLIT-TASTE-1 Answer in two lines at most'],
  strategy: ['MEMP-SPLIT-STRAT-1 One task per file'],
  review: ['MEMP-SPLIT-REVIEW-1 Compare item by item with the request'],
};
/** 读不出来的两条（synthetic）：索引指向不存在的文件；detail 的 kind 不认识 */
const BROKEN_MISSING = 'MEMP-BROKEN-MISSING The index points to a missing file';
const BROKEN_BADKIND = 'MEMP-BROKEN-BADKIND The detail has an unknown kind';
/** 会话打开之后在记忆页加的两条 */
const E1 = 'MEM04-PAGE-TASTE Answer with the conclusion first';
const E2 = 'MEM04-CHECK-AGAIN Mention the risk before the steps';
/** 增强脚本（synthetic，FAKE_ENHANCE_SCRIPT）：每个任务只回一句、不改条目 */
const ENHANCE_SCRIPT = { taste: [{ say: 'No TASTE changes today.' }], strategy: [{ say: 'No STRATEGY changes today.' }],
  review: [{ say: 'No REVIEW changes today.' }] };
/** 索引文件名与标题（§3.1） */
const INDEX_FILE = { fact: 'MEMORY.md', taste: 'TASTE.md', strategy: 'STRATEGY.md', review: 'REVIEW.md' };
const INDEX_TITLE = { fact: 'Facts', taste: 'TASTE', strategy: 'STRATEGY', review: 'REVIEW' };

// ---------- 小工具 ----------

/** @brief 两个值的 JSON 相同。 */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
/** @brief 两个列表作为集合相同。 */
const sameSet = (left, right) => same([...left].sort(), [...right].sort());
/** @brief 错误的一行文字。 */
function oneLineError(error) {
  return String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ').slice(0, 400);
}
/** @brief §6.3 的估算：中日韩字符每个 1，其余字符数 ÷ 4 向上取整（按码点）。 */
function estimateTokens(text) {
  const ranges = [[0x3000, 0x303f], [0x3040, 0x30ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xac00, 0xd7af],
    [0xf900, 0xfaff], [0xff00, 0xffef]];
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (ranges.some(([low, high]) => code >= low && code <= high)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}
/** @brief 项目目录名（§3，同 pi 的会话目录编码）。 */
const projectDirName = (cwd) => `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
/** @brief 记忆目录、用户级目录、某个项目的目录。 */
const memoryRoot = (ctx) => join(ctx.userData, 'memory');
const userBase = (ctx) => join(memoryRoot(ctx), 'user');
const projectBase = (ctx, cwd) => join(memoryRoot(ctx), 'projects', projectDirName(cwd));

/** @brief pi-ai 的 getCurrentSystemMessage（按 pi 1.3.0 包里的文件路径载入，§11.1 最后一行）。 */
async function loadTranscript() {
  const file = join(appRoot, 'node_modules/@earendil-works/pi-ai/dist/utils/transcript.js');
  return (await import(pathToFileURL(file).href)).getCurrentSystemMessage;
}
const getCurrentSystemMessage = await loadTranscript();

// ---------- 记忆文件（synthetic test setup，按 §3 的格式） ----------

/** @brief 一个 detail 文件（§3.2 的版式）；badKind 时 kind 写成认不出的值（读不出来的条目）。 */
function detailText(kind, abstract, badKind = false) {
  const by = JSON.stringify('2026-10-20 · You');
  return ['---', `kind: ${badKind ? 'bogus' : kind}`, `abstract: ${JSON.stringify(abstract)}`, 'source: user',
    `created: ${by}`, `modified: ${by}`, 'evidence: []', '---', '## Evidence', '', '## Details',
    'Synthetic entry written by tests/ui/mem-app-prompt.mjs.', '', '## Revisions', ''].join('\n');
}

/**
 * @brief 写一层的索引与 detail（synthetic）：每种一个索引文件（没有条目的种类不写），slug 为 <prefix>-<kind>-<n>。
 * @param base 这一层的目录
 * @param entries 种类 → abstract 列表
 * @param extra 种类 → 追加在索引末尾的读不出来的行 [{ abstract, slug, text（detail 全文；null 时不写文件） }]
 */
function writeLayer(base, prefix, entries, extra = {}) {
  mkdirSync(join(base, 'entries'), { recursive: true });
  for (const kind of MEMORY_KINDS) {
    const items = (entries[kind] ?? []).map((abstract, i) => ({ abstract, slug: `${prefix}-${kind}-${i + 1}`,
      text: detailText(kind, abstract) }));
    const all = [...items, ...(extra[kind] ?? [])];
    if (all.length === 0) continue;
    for (const item of all) {
      if (item.text !== null) writeFileSync(join(base, 'entries', `${item.slug}.md`), item.text);
    }
    const lines = all.map((item) => `- [${item.abstract}](entries/${item.slug}.md)`);
    writeFileSync(join(base, INDEX_FILE[kind]), `${[`# ${INDEX_TITLE[kind]}`, ...lines].join('\n')}\n`);
  }
}

/** @brief 一个项目的记忆目录（synthetic）：project.json（§3）与条目。 */
function writeProjectMemory(ctx, cwd, prefix, entries, extra = {}) {
  const base = projectBase(ctx, cwd);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'project.json'), `${JSON.stringify({ cwd: resolve(cwd) }, null, 2)}\n`);
  writeLayer(base, prefix, entries, extra);
}

/** @brief 测试准备的记忆文件：用户级、没有角色文件的项目（含读不出来的两条）、分开配置的项目。 */
function seedMemory(ctx) {
  writeLayer(userBase(ctx), 'u', USER_MEMORY);
  const broken = [{ abstract: BROKEN_MISSING, slug: 'broken-missing', text: null },
    { abstract: BROKEN_BADKIND, slug: 'broken-badkind', text: detailText('strategy', BROKEN_BADKIND, true) }];
  writeProjectMemory(ctx, ctx.plain, 'plain', PLAIN_MEMORY, { strategy: broken });
  writeProjectMemory(ctx, ctx.split, 'split', SPLIT_MEMORY);
}

// ---------- 期望的分节 ----------

/** @brief 每个项目此刻（会话打开时）应读到的两层条目：{ user, project }（种类 → abstract 列表）。 */
function layersOf(ctx, cwd, { e1 = false, e2 = false } = {}) {
  const empty = { fact: [], taste: [], strategy: [], review: [] };
  let project = empty;
  if (cwd === ctx.plain) project = { ...PLAIN_MEMORY, taste: [...PLAIN_MEMORY.taste, ...(e1 ? [E1] : [])] };
  if (cwd === ctx.split) project = SPLIT_MEMORY;
  if (cwd === ctx.invalid && e2) project = { ...empty, taste: [E2] };
  return { user: USER_MEMORY, project };
}

/**
 * @brief 一个身份应得的分节（§5.1、§5.2）：按 taste、strategy、review、facts 的顺序，用户级在前、本项目在后，每行
 *        `- <abstract>`；两层都没有条目的种类没有这一段。
 * @return [{ name, content }]
 */
function expectedSections(seat, layers) {
  return MEMORY_KINDS.filter((kind) => SEAT_KINDS[seat].includes(kind)).map((kind) => ({ name: SECTION_OF[kind],
    lines: [...layers.user[kind], ...layers.project[kind]] })).filter((item) => item.lines.length > 0)
    .map((item) => ({ name: item.name, content: item.lines.map((line) => `- ${line}`).join('\n') }));
}

// ---------- 读 system prompt ----------

/**
 * @brief 把 rest（身份段之后的部分）按 pi 的段切开：每段 "\n\n<name>\n…\n</name>"；切不开时为 null。
 * @return [{ name, content }]，按出现的顺序
 */
function splitSections(rest) {
  const out = [];
  let at = 0;
  while (at < rest.length) {
    const open = /^\n\n<([a-z][a-z0-9_-]*)>\n/.exec(rest.slice(at));
    if (!open) return null;
    const close = `\n</${open[1]}>`;
    const start = at + open[0].length;
    let end = rest.indexOf(close, start);
    while (end >= 0 && end + close.length !== rest.length && !rest.startsWith('\n\n<', end + close.length)) {
      end = rest.indexOf(close, end + 1);
    }
    if (end < 0) return null;
    out.push({ name: open[1], content: rest.slice(start, end) });
    at = end + close.length;
  }
  return out;
}

/**
 * @brief 一个请求的 system prompt（§4.2：开头就是身份段，之后是 pi 的各段）：{ identity（身份段全文）, tools（<tools> 的
 *        内容）, rules（<rules> 的各行）, sections（之后的段）}；不以附录 A.1 + <tools> 开头或切不开时为 null。
 */
function parsePrompt(system) {
  if (typeof system !== 'string') return null;
  const head = identityHead(system);
  if (!head) return null;
  const toolsEnd = system.indexOf(TOOLS_TO_RULES, head.length);
  if (toolsEnd < 0) return null;
  const rulesStart = toolsEnd + TOOLS_TO_RULES.length;
  const rulesEnd = system.indexOf(RULES_END, rulesStart);
  if (rulesEnd < 0) return null;
  const identity = system.slice(0, rulesEnd + RULES_END.length);
  const sections = splitSections(system.slice(identity.length));
  if (!sections) return null;
  return { identity, handoff: head.handoff !== null, handoffText: head.handoff,
    tools: system.slice(head.length, toolsEnd),
    rules: system.slice(rulesStart, rulesEnd).split('\n'), sections };
}

/** @brief <tools> 里列出的工具名；格式不对时为 null。 */
function listedTools(tools) {
  const parts = tools.split('\n\n');
  if (parts.length !== 2 || parts[1] !== TOOLS_LAST) return null;
  if (parts[0] === '(none)') return [];
  const names = parts[0].split('\n').map((line) => /^- ([^\s:]+): \S/.exec(line)?.[1] ?? null);
  return names.includes(null) ? null : names;
}

/** @brief 声明的工具下应有的 shell 规则（pi buildRules）；没有时为 null。 */
function shellRuleFor(names) {
  const bash = names.includes('bash');
  const powershell = names.includes('powershell');
  if (!(bash || powershell) || ['grep', 'find', 'ls'].some((name) => names.includes(name))) return null;
  return bash && powershell ? SHELL_RULE.both : bash ? SHELL_RULE.bash : SHELL_RULE.powershell;
}

/**
 * @brief 一个请求的身份段与工具是否一致（§4.1、§4.2、MEM-02）：<tools> 列出的就是请求 tools 参数里的内置工具（有说明的），
 *        最后一行固定；shell 规则按声明的工具（不含 bash 时没有）；规则每行 `- `，最后两条固定；没有 pi 的身份句与文档指引。
 * @return 问题列表（空为一致）
 */
function identityProblems(item) {
  const parsed = parsePrompt(item.system);
  if (!parsed) return [`does not start with appendix A.1 + <tools>/<rules>: ${item.system.slice(0, 80)}`];
  const bad = [];
  const names = listedTools(parsed.tools);
  const builtins = item.tools.filter((name) => BUILTIN_TOOLS.includes(name));
  // 有 promptSnippet 的 Mori 工具也列在 <tools> 里：subagent（docs/specs/subagent.md §6.1）；memory、TaskBoard 的工具没有
  const want = [...builtins, ...item.tools.filter((name) => name === 'subagent')];
  if (names === null) bad.push(`<tools> format: ${parsed.tools.slice(0, 120)}`);
  else if (!sameSet(names, want)) bad.push(`<tools> ${names.join(',')} vs request ${item.tools.join(',')}`);
  const shell = shellRuleFor(builtins);
  const shellLines = parsed.rules.filter((line) => Object.values(SHELL_RULE).includes(line.slice(2)));
  if (shell === null ? shellLines.length > 0 : !(shellLines.length === 1 && parsed.rules[0] === `- ${shell}`)) {
    bad.push(`shell rule ${JSON.stringify(shellLines)} for ${builtins.join(',')}`);
  }
  if (!parsed.rules.every((line) => line.startsWith('- ')) || !same(parsed.rules.slice(-2), FIXED_RULES)) {
    bad.push(`rules ${JSON.stringify(parsed.rules.slice(-3))}`);
  }
  if (item.system.includes(PI_IDENTITY) || item.system.includes(PI_DOCS)
    || parsed.sections.some((section) => section.name === 'docs' || section.name === 'tools')) {
    bad.push('pi identity sentence or docs present');
  }
  const sentence = expectedHandoff(item.tools);
  if (parsed.handoffText !== sentence) bad.push(`appendix A.1.1 ${JSON.stringify(parsed.handoffText)} with tools `
    + `${item.tools.join(',')} (expected ${JSON.stringify(sentence)})`);
  return bad;
}

/**
 * @brief 一个请求的四个分节是否符合（§5.1、§5.2、§5.3）：内容与期望逐字相同，都在 cwd 之后。会话第一次运行时顺序为
 *        mori_team（有时）、taste、strategy、review、facts；会话中途才出现（或删掉后又出现）的段由 pi 排到最后
 *        （§5.3 补丁重放的规则），这时 strict 为假，只比较内容、不比较先后。
 * @return 问题列表（空为符合）
 */
function sectionProblems(item, seat, layers, strict = true) {
  const parsed = parsePrompt(item.system);
  if (!parsed) return ['no identity section'];
  const want = expectedSections(seat, layers);
  const got = parsed.sections.filter((section) => MEMORY_SECTIONS.includes(section.name));
  const key = (list) => list.map((section) => JSON.stringify(section));
  const bad = [];
  if (strict ? !same(got, want) : !sameSet(key(got), key(want))) {
    bad.push(`sections ${brief(got, 400)} want ${brief(want, 400)}`);
  }
  const names = parsed.sections.map((section) => section.name);
  const tail = names.slice(names.indexOf('cwd') + 1);
  const rest = tail[0] === 'mori_team' ? tail.slice(1) : tail;
  const order = strict ? same(rest, want.map((section) => section.name))
    : sameSet(tail.filter((name) => name !== 'mori_team'), want.map((section) => section.name));
  if (names.indexOf('cwd') < 0 || !order) bad.push(`order ${names.join(',')}`);
  return bad;
}

/** @brief 请求里的段名（身份段之后，按顺序）。 */
const sectionNames = (item) => parsePrompt(item.system)?.sections.map((section) => section.name) ?? null;

// ---------- 会话文件 ----------

/** @brief 会话文件里全部消息（type 为 message 的 message，按顺序；会话是一条线，没有分支）。 */
const fileMessages = (file) => readJsonl(file).filter((entry) => entry.type === 'message')
  .map((entry) => entry.message);
/** @brief 会话文件里 role: system 的消息条数（第一条完整的，之后每条是补丁）。 */
const systemCount = (file) => fileMessages(file).filter((message) => message.role === 'system').length;

/**
 * @brief 会话文件读回的当前分节（pi-ai getCurrentSystemMessage，§11.2 M7）：{ preamble, memory（[{ name, content }]，
 *        四个分节，去掉 <name> 标签）}；没有 system 消息时为 null。
 */
function fileSections(file) {
  const current = getCurrentSystemMessage(fileMessages(file));
  if (!current) return null;
  const sections = current.sections ?? {};
  const memory = MEMORY_SECTIONS.filter((name) => typeof sections[name] === 'string').map((name) => {
    const text = sections[name];
    const open = `<${name}>\n`;
    const close = `\n</${name}>`;
    return { name, content: text.startsWith(open) && text.endsWith(close)
      ? text.slice(open.length, -close.length) : text };
  });
  return { preamble: sections.preamble ?? null, memory };
}

/** @brief 请求的四个分节（[{ name, content }]）。 */
const requestMemory = (item) => (parsePrompt(item.system)?.sections ?? [])
  .filter((section) => MEMORY_SECTIONS.includes(section.name));

/** @brief 会话文件读回的分节与身份段等于这个请求实际发出的（§5.2 最后一条、§11.2 M7）。 */
function fileMatches(file, item) {
  const fromFile = fileSections(file);
  const parsed = parsePrompt(item?.system);
  return Boolean(fromFile && parsed) && fromFile.preamble === parsed.identity
    && same(fromFile.memory, requestMemory(item));
}

// ---------- 准备、App 与会话 ----------

/** @brief 测试准备（synthetic test setup）：七个临时项目、数据目录、记忆文件、合成端点。 */
async function setup(ctx) {
  ctx.plain = tempProject('mori-mem-prompt-plain-');
  writeFileSync(join(ctx.plain, 'AGENTS.md'), mergedAgentsMd());
  ctx.split = tempProject('mori-mem-prompt-split-');
  writeRoles(ctx.split, MEM_PROMPT_ROLES);
  ctx.readonly = tempProject('mori-mem-prompt-ro-');
  writeRoles(ctx.readonly, [{ name: 'chat', description: 'Talks with the user', seats: ['dialog'], tools: ['read'] },
    { name: 'executor', description: 'Changes code and runs commands to finish a task' }]);
  ctx.sys = tempProject('mori-mem-prompt-sys-');
  mkdirSync(join(ctx.sys, '.pi'), { recursive: true });
  writeFileSync(join(ctx.sys, '.pi', 'SYSTEM.md'), `${PROJECT_SYSTEM_MARK} You are a project assistant.\n`);
  ctx.guard = tempProject('mori-mem-prompt-guard-');
  ctx.invalid = tempProject('mori-mem-prompt-invalid-');
  mkdirSync(join(ctx.invalid, '.mori', 'agents'), { recursive: true });
  writeFileSync(join(ctx.invalid, '.mori', 'agents', 'executor.md'),
    '---\nname: executor\ndescription: A role\ncolor: blue\n---\nBroken on purpose (synthetic).\n');
  ctx.enh = tempProject('mori-mem-prompt-enh-');
  ctx.seed = { providers: [tbProvider('mpa', PROXY, [tbModel(MODEL)])], trusted: [ctx.sys] };
  seedTeamUserData(ctx.userData, ctx.seed);
  writeFileSync(join(ctx.userData, 'pi', 'SYSTEM.md'), `${USER_SYSTEM_MARK} You are another assistant.\n`);
  seedMemory(ctx);
  const script = join(args.shots, 'enhance-script.json');
  writeFileSync(script, `${JSON.stringify(ENHANCE_SCRIPT, null, 2)}\n`);
  ctx.ep = await startTbEndpoint(PORT, PROXY, { FAKE_ENHANCE_SCRIPT: script });
  await startTbApp(ctx);
}

/** @brief 等协作空闲；超时时报错（步骤失败）。 */
async function settle(ctx, who, timeout = 120000) {
  if (!(await waitTeamIdle(ctx, who, { timeout }))) throw new Error(`the session ${who.tab} did not become idle`);
}

/**
 * @brief 在这个会话里发一条消息，等端点收到请求、整个会话（含协作）空闲；第一次发送后补上会话文件。
 * @return 发送的时刻（之后的请求都是这条消息引起的）
 */
async function send(ctx, who, text, timeout = 120000) {
  const since = Date.now();
  await sendMessage(ctx, who.tab, text);
  if (!who.sessionFile) Object.assign(who, await userSession(ctx, who.tab));
  const asked = await poll(() => ctx.ep.proxy.captures.some((item) => item.chat && item.t >= since), 30000, 100);
  if (!asked) throw new Error(`no request for "${text}"`);
  await settle(ctx, who, timeout);
  return since;
}

/** @brief since 之后（到 until 之前）的对话请求，可再按 sessionOf 的结果筛。 */
function requestsOf(ctx, since, where = () => true, until = Infinity) {
  return scenarioRequests(ctx.ep, null, { since }).filter((item) => item.t < until && where(item.info, item));
}

/**
 * @brief 在记忆页加一条（§10.1 New entry）：让 tab 这个会话有焦点（Project 跟随它的项目），打开记忆页、选层与分节、
 *        New entry、填 Abstract 与 Details、Save，等列表里出现它，再点 Back to app。
 * @return 保存后列表里的 abstract（按顺序）
 */
async function addEntryOnPage(ctx, tab, { scope, section, abstract }) {
  const { page } = ctx;
  await showTab(ctx, tab);
  await page.getByTestId('nav-memory').click();
  await page.getByTestId('memory-page').waitFor({ timeout: 10000 });
  const enabled = (id) => page.waitForFunction((testId) => {
    const el = document.querySelector(`[data-testid="${testId}"]`);
    return el && !el.disabled;
  }, id, { timeout: 15000 });
  await enabled(`memory-scope-${scope}`);
  const layer = page.getByTestId(`memory-scope-${scope}`);
  if ((await layer.getAttribute('aria-pressed')) !== 'true') await layer.click();
  await page.getByTestId(`memory-section-${section}`).click();
  await enabled('memory-new');
  await page.getByTestId('memory-new').click();
  await page.getByTestId('memory-form').waitFor({ timeout: 10000 });
  await page.getByTestId('memory-abstract').fill(abstract);
  await page.getByTestId('memory-details').fill('Added on the Memory page by tests/ui/mem-app-prompt.mjs.');
  await page.getByTestId('memory-save').click();
  await page.locator('[data-testid="memory-row"]', { hasText: abstract }).waitFor({ timeout: 15000 });
  const rows = await page.locator('[data-testid="memory-row"] .memory-row-title').allTextContents();
  await page.locator('[data-testid="memory-page"] .topbar button', { hasText: 'Back to app' }).click();
  await page.locator(`.pane-slot:not([hidden]) ${paneSel(tab)}`).waitFor({ timeout: 10000 });
  return rows;
}

// ---------- 步骤 prompt：关闭模式的主 Agent（没有角色文件） ----------

/** @brief 没有角色文件的项目：打开会话、发两条（关闭模式的主 Agent）。MEM-01、MEM-02、MEM-03、MEM-11。 */
async function prompt(ctx) {
  const opened = Date.now();
  const who = { tab: await openProject(ctx, ctx.plain) };
  ctx.main = who;
  const s1 = await send(ctx, who, 'First question about the project');
  const count1 = systemCount(who.sessionFile);
  await send(ctx, who, 'Second question about the project');
  const reqs = requestsOf(ctx, s1, (info) => info.kind === 'dialog');
  const first = reqs[0];
  ctx.mainOpenLayers = layersOf(ctx, ctx.plain);
  promptIdentity(ctx, who, first, reqs);
  promptSections(ctx, who, reqs, count1);
  const logs = appLogLines(ctx, SYSTEM_LOG, opened);
  const userSystem = join(ctx.userData, 'pi', 'SYSTEM.md');
  record('MEM-01 a user-level SYSTEM.md (<agentDir>/SYSTEM.md) is read by pi but not used: no request contains it, '
    + `and the kernel logs "${SYSTEM_LOG}<path>" once for the session (two runs)`, logs.length === 1
    && logs[0].endsWith(`${SYSTEM_LOG}${userSystem}`) && reqs.every((item) => !item.system.includes(USER_SYSTEM_MARK)),
  brief({ logs }));
  record('MEM-11 off mode, base agent (no role files): every request of the main agent has the memory tool',
    reqs.length >= 2 && reqs.every((item) => item.tools.includes('memory')), brief(reqs.map((item) => item.tools)));
}

/** @brief MEM-01：第一条请求的身份段（结构、默认工具、token 数、会话文件里的 preamble）。 */
function promptIdentity(ctx, who, first, reqs) {
  const parsed = parsePrompt(first?.system);
  const problems = first ? identityProblems(first) : ['no request'];
  const listed = parsed ? listedTools(parsed.tools) : null;
  record('MEM-01 a main-agent request\'s system starts with appendix A.1, then <tools> and <rules> (no pi identity '
    + 'sentence, no docs); with the default tools <tools> lists read, bash, edit, write and subagent (normal mode, '
    + 'subagent spec §2) with the fixed last line, <rules> opens with the bash rule and ends with the two fixed rules; '
    + 'memory is sent as a tool but not listed',
  problems.length === 0 && same(listed, ['read', 'bash', 'edit', 'write', 'subagent'])
    && first.tools.includes('memory'),
  brief({ problems, listed, tools: first?.tools, rules: parsed?.rules }));
  const tokens = parsed ? estimateTokens(parsed.identity) : null;
  record(`MEM-01 with the default tools the identity section actually sent is at most ${LIMIT} tokens (§6.3 estimate)`,
    tokens !== null && tokens <= LIMIT, brief({ tokens, chars: parsed?.identity.length }));
  const fromFile = fileSections(who.sessionFile);
  record('MEM-01 the session file records the identity section as the system message preamble, equal to what was '
    + 'sent (pi-ai getCurrentSystemMessage), and both requests of the session have the same system prompt',
  fromFile?.preamble === parsed?.identity && reqs.length >= 2 && reqs.every((item) => item.system === first.system),
  brief({ preamble: fromFile?.preamble?.slice(0, 60), requests: reqs.length }));
}

/** @brief MEM-02、MEM-03：主 Agent 的四个分节（内容、顺序、读不出来的条目、两次运行没有补丁、会话文件）。 */
function promptSections(ctx, who, reqs, count1) {
  const bad = reqs.flatMap((item) => sectionProblems(item, 'main', ctx.mainOpenLayers));
  const names = reqs[0] ? sectionNames(reqs[0]) : null;
  record('MEM-02 the four sections hold the user-level abstracts first, then this project\'s, one "- <abstract>" per '
    + 'line; they come after cwd in the order taste, strategy, review, facts; STRATEGY has only the user-level entry '
    + '(the project\'s two unreadable entries are left out)', reqs.length >= 2 && bad.length === 0
    && reqs.every((item) => !item.system.includes('MEMP-BROKEN')), brief({ bad, names }));
  const after = systemCount(who.sessionFile);
  record('MEM-02 two runs in a row write no patch: the session file has one system message after the first run and '
    + 'still one after the second', count1 === 1 && after === 1, brief({ count1, after }));
  record('MEM-02 the session file (getCurrentSystemMessage) holds the same four sections as the request',
    fileMatches(who.sessionFile, reqs.at(-1)), brief(fileSections(who.sessionFile)?.memory));
  record('MEM-03 off mode: the main agent gets all four kinds (taste, strategy, review, facts)',
    reqs.length > 0 && same(requestMemory(reqs[0]).map((s) => s.name), ['taste', 'strategy', 'review', 'facts']),
    brief(names));
}

// ---------- 步骤 toolsPage：工具页上 memory 的来源 ----------

/** @brief 让 tab 这个会话在前面，打开 Customize → Built-in tools 读每一行（m6-tools-helpers toolRows），再 Back to app。 */
async function builtinToolRows(ctx, tab) {
  await showTab(ctx, tab);
  await openToolsSection(ctx.page, 'builtin');
  const rows = await toolRows(ctx.page);
  await ctx.page.locator('[data-testid="tools-page"] .topbar button', { hasText: 'Back to app' }).click();
  await ctx.page.locator(`.pane-slot:not([hidden]) ${paneSel(tab)}`).waitFor({ timeout: 10000 });
  return rows;
}

/** @brief MEM-11：工具页（Customize → 内置工具）上 memory 那一行的来源写 Mori，没有开关，下面一行原因（2026-10-26，WP-08）。 */
async function toolsPage(ctx) {
  const who = ctx.main;
  if (!who) throw new Error('the prompt step did not run');
  const rows = await builtinToolRows(ctx, who.tab);
  const row = rows.find((item) => item.name === 'memory');
  record('MEM-11 the Tools page lists the memory tool with source "Mori" (like the TaskBoard tools), no switch, and '
    + 'the line "Mori turns this on for the main agent." under it', row?.tag === 'Mori' && row.checked === null
    && JSON.stringify(row.notes) === JSON.stringify([TOOL_REASONS.memory]),
  brief(rows.map((item) => `${item.name}|${item.tag}|${item.state}|${item.notes.join(' ')}`)));
}

// ---------- 步骤 snapshot：会话打开时定下、记忆页的条目进 prompt ----------

/** @brief 会话打开之后在记忆页加一条 TASTE（本项目）：开着的会话不变，新会话有。MEM-04、MEM-05。 */
async function snapshot(ctx) {
  const who = ctx.main;
  if (!who?.sessionFile) throw new Error('the prompt step did not run');
  const rows = await addEntryOnPage(ctx, who.tab, { scope: 'project', section: 'taste', abstract: E1 });
  ctx.e1 = true;
  const s3 = await send(ctx, who, 'Third question after the Memory page');
  const third = requestsOf(ctx, s3, (info) => info.kind === 'dialog');
  const bad = third.flatMap((item) => sectionProblems(item, 'main', ctx.mainOpenLayers));
  record('MEM-04 an entry added on the Memory page after the session opened is not in that session\'s next request '
    + '(TASTE is still the open-time snapshot) and no patch is written', third.length > 0 && bad.length === 0
    && third.every((item) => !item.system.includes(E1)) && systemCount(who.sessionFile) === 1
    && rows.includes(E1), brief({ bad, rows, count: systemCount(who.sessionFile) }));
  const fresh = { tab: await newSession(ctx) };
  ctx.fresh = fresh;
  const s1 = await send(ctx, fresh, 'Question in a new session');
  const reqs = requestsOf(ctx, s1, (info) => info.kind === 'dialog');
  const taste = requestMemory(reqs[0] ?? { system: '' }).find((section) => section.name === 'taste');
  const want = [...USER_MEMORY.taste, ...PLAIN_MEMORY.taste, E1].map((line) => `- ${line}`).join('\n');
  record('MEM-05 a TASTE entry added on the Memory page (this project) is in the system of the next new session\'s '
    + 'first request, at the end of <taste> after the user-level and earlier project entries',
  reqs.length > 0 && taste?.content === want, brief({ taste: taste?.content }));
  const sections = reqs.flatMap((item) => sectionProblems(item, 'main', layersOf(ctx, ctx.plain, { e1: true })));
  record('MEM-04 a new session gets the new version: all its sections are read when it opens (taste with the new '
    + 'entry)',
    reqs.length > 0 && sections.length === 0 && fileMatches(fresh.sessionFile, reqs.at(-1)), brief(sections));
}

// ---------- 步骤 merged：合并会话打开、关掉协作模式之前 ----------

/** @brief 没有角色文件的会话切到协作模式（合并会话）发两条：一条补丁、合并会话的三种、有 memory。MEM-02/03/04/11。 */
async function merged(ctx) {
  const who = ctx.main;
  if (!who?.sessionFile || !ctx.e1) throw new Error('the snapshot step did not run');
  await showTab(ctx, who.tab);
  const before = systemCount(who.sessionFile);
  await clickTeamSwitch(ctx, who.tab, 'always');
  const s4 = await send(ctx, who, 'Team question one');
  const after4 = systemCount(who.sessionFile);
  const s5 = await send(ctx, who, 'Team question two');
  const after5 = systemCount(who.sessionFile);
  const run4 = requestsOf(ctx, s4, (info) => info.kind === 'merged-create', s5);
  const all = requestsOf(ctx, s4, (info) => info.kind === 'merged-create');
  const problems = run4[0] ? identityProblems(run4[0]) : ['no request'];
  record('MEM-02 after team mode is turned on (merged session), the first run\'s <tools> lists exactly the built-in '
    + 'tools sent in the request (and the shell rule follows them); the second run writes no patch',
  problems.length === 0 && after5 === after4, brief({ problems, tools: run4[0]?.tools, after4, after5 }));
  const sections = all.flatMap((item) => sectionProblems(item, 'merged', ctx.mainOpenLayers, false));
  const late = all.every((item) => sectionNames(item)?.at(-1) === 'mori_team');
  record('MEM-04 switching to team mode writes exactly one section patch at the start of that run, and its content is '
    + 'still the open-time snapshot (the Memory page entry added later is not in it; mori_team, new in the session, '
    + 'is placed last by pi\'s patch replay, §5.3)', after4 === before + 1 && all.length > 0 && sections.length === 0
    && late && all.every((item) => !item.system.includes(E1)) && fileMatches(who.sessionFile, all.at(-1)),
  brief({ before, after4, sections, names: sectionNames(all[0] ?? { system: '' }) }));
  record('MEM-03 the merged session (dialog and create) gets taste, strategy and facts, not review',
    all.length > 0 && all.every((item) => same(requestMemory(item).map((s) => s.name), ['taste', 'strategy', 'facts'])),
    brief(all.map(sectionNames)));
  record('MEM-11 the merged session in team mode has the memory tool in every request',
    all.length > 0 && all.every((item) => item.tools.includes('memory')), brief(all.map((item) => item.tools)));
}

// ---------- 步骤 split：分开配置的每一种会话 ----------

/** @brief 分开配置（scenarios/mem-prompt.mjs 的 mem-prompt-split）：关闭模式、协作模式两条、回到关闭模式两条。 */
async function split(ctx) {
  const who = { tab: await openProject(ctx, ctx.split) };
  ctx.splitWho = who;
  const t = {};
  const rows = {};
  t.s1 = await send(ctx, who, 'Hello in off mode');
  t.n1 = systemCount(who.sessionFile);
  rows.off = await builtinToolRows(ctx, who.tab);
  await clickTeamSwitch(ctx, who.tab, 'always');
  rows.switched = await builtinToolRows(ctx, who.tab);
  t.s2 = await send(ctx, who, 'Please check the notes', 180000);
  t.n2 = systemCount(who.sessionFile);
  t.read = Date.now();
  rows.team = await builtinToolRows(ctx, who.tab);
  t.s4 = await send(ctx, who, 'One more question in team mode');
  t.n4 = systemCount(who.sessionFile);
  await clickTeamSwitch(ctx, who.tab, 'off');
  t.s5 = await send(ctx, who, 'Back in off mode');
  t.n5 = systemCount(who.sessionFile);
  t.s6 = await send(ctx, who, 'Second message in off mode');
  t.n6 = systemCount(who.sessionFile);
  const req = splitRequests(ctx, t);
  splitIdentity(req);
  splitSeats(ctx, req);
  splitInstances(ctx, who);
  splitTools(ctx, who, req);
  splitPatches(who, req, t);
  splitToolsPage(ctx, req, rows, t);
}

/** 分开配置时用户会话注册的 TaskBoard 工具（docs/v0/screens/tools.md"内置工具"的列表：分开时 3 个） */
const SPLIT_USER_TOOLS = ['agent_message', 'board_read', 'read_session'];

/**
 * @brief tools.md"内置工具"列表一行（2026-10-26 补，WP-08 的状态表各行的用例）：分开配置的用户会话只列 3 个 TaskBoard 工具
 *        （来源 Mori、没有开关、下面一行原因）；"Enabled"是这个会话上一轮运行时的样子（每行与那一轮请求的 tools 一致）：
 *        开关 Task mode 之后不变，到下一条消息开始才变成 Task mode 的。读工具页不发请求。
 */
function splitToolsPage(ctx, req, rows, t) {
  const board = (list) => list.filter((row) => row.tag === 'Mori' && row.name !== 'memory');
  const listed = Object.values(rows).every((list) => same(board(list).map((row) => row.name).sort(), SPLIT_USER_TOOLS)
    && board(list).every((row) => row.checked === null && same(row.notes, [TOOL_REASONS.task])));
  record('M12 Customize › Built-in tools of a split-config user session lists exactly the three TaskBoard tools '
    + 'board_read, read_session and agent_message (source "Mori", no switch, "Mori turns this on and off with Task '
    + 'mode." under each), before and after Task mode is turned on', listed,
  brief(Object.fromEntries(Object.entries(rows).map(([key, list]) => [key, board(list).map((row) => row.name)]))));
  const offRun = req.offDialog.at(-1);
  const teamRun = requestsOf(ctx, t.s2, (info) => info.scenario === 'mem-prompt-split' && info.role === 'chat'
    && info.kind === 'team-dialog', t.read).at(-1);
  const states = (list) => list.map((row) => `${row.name}:${row.state}`);
  const matches = (list, run) => Boolean(run) && list.length > 0
    && list.every((row) => (row.state === 'Enabled') === run.tools.includes(row.name));
  record('M12 "Enabled" on the Tools page is how the session ran last: right after Task mode is turned on every row '
    + 'is unchanged (the tools of the last off-mode request); after the next message the rows are the tools of that '
    + 'Task mode run (team.ts beforeUserRun)', matches(rows.off, offRun)
    && same(states(rows.switched), states(rows.off)) && matches(rows.team, teamRun)
    && !same(states(rows.team), states(rows.switched)),
  brief({ off: states(rows.off), switched: states(rows.switched), team: states(rows.team), offTools: offRun?.tools,
    teamTools: teamRun?.tools }));
}

/** @brief 分开配置的请求，按会话分好。 */
function splitRequests(ctx, t) {
  const of = (since, until, role, kind) => requestsOf(ctx, since, (info) => info.scenario === 'mem-prompt-split'
    && info.role === role && info.kind === kind, until);
  return {
    offDialog: of(t.s1, t.s2, 'chat', 'off-dialog'), offAsk: of(t.s1, t.s2, 'executor', 'ask'),
    teamDialog: of(t.s2, t.s5, 'chat', 'team-dialog'), firstTeam: of(t.s2, t.s4, 'chat', 'team-dialog'),
    create: of(t.s2, t.s5, 'planner', 'create'), task: of(t.s2, t.s5, 'executor', 'task'),
    teamAsk: of(t.s2, t.s5, 'reviewer', 'ask'), close: of(t.s2, t.s5, 'planner', 'close'),
    sub: of(t.s2, t.s5, 'watcher', 'subscription'), backOff: of(t.s5, Infinity, 'chat', 'off-dialog'),
  };
}

/** @brief MEM-01：用户会话与每一种实例会话（立项、结案、task、两种临时提问、订阅）的请求都以身份段开头。 */
function splitIdentity(req) {
  const kinds = ['offDialog', 'teamDialog', 'create', 'close', 'task', 'teamAsk', 'offAsk', 'sub'];
  const missing = kinds.filter((kind) => req[kind].length === 0);
  const bad = kinds.flatMap((kind) => req[kind].flatMap((item) => identityProblems(item)
    .map((text) => `${kind}: ${text}`)));
  record('MEM-01 every kind of session has the identity section with <tools>/<rules> matching its own tools: the user '
    + 'session (off mode and team mode), create, close, task, ask (team mode, from a task) and ask (off mode), '
    + 'subscription', missing.length === 0 && bad.length === 0, brief({ missing, bad: bad.slice(0, 6) }));
  const handoff = Object.fromEntries(kinds.map((kind) => [kind, [...new Set(req[kind]
    .map((item) => parsePrompt(item.system)?.handoff ?? null))]]));
  record('MEM-01 the handoff sentence (appendix A.1.1, 2026-10-26) ends the third line exactly in the sessions that '
    + 'have task_create or agent_message (checked for every request above): the team dialog and create have it, '
    + 'both asks (no agent_message) do not', same(handoff.teamDialog, [true]) && same(handoff.create, [true])
    && same(handoff.teamAsk, [false]) && same(handoff.offAsk, [false]),
  brief({ handoff, tools: kinds.map((kind) => [kind, req[kind][0]?.tools.filter((name) => HANDOFF_TOOLS
    .includes(name))]) }));
}

/** @brief MEM-03：§5.1 每一行（请求里的分节）。 */
function splitSeats(ctx, req) {
  const layers = layersOf(ctx, ctx.split);
  const rows = [['offDialog', 'main'], ['teamDialog', 'dialog'], ['create', 'create'], ['close', 'close'],
    ['task', 'sub'], ['teamAsk', 'sub'], ['offAsk', 'sub'], ['sub', 'sub']];
  const view = {};
  const bad = [];
  for (const [kind, seat] of rows) {
    view[kind] = req[kind].map((item) => requestMemory(item).map((s) => s.name).join('+'));
    if (req[kind].length === 0) bad.push(`${kind}: no request`);
    for (const item of req[kind]) bad.push(...sectionProblems(item, seat, layers).map((text) => `${kind}: ${text}`));
  }
  record('MEM-03 split team mode, every row of §5.1 in the requests: dialog only taste; create taste, strategy, facts; '
    + 'close only review; task, ask (team mode and off mode) and subscription strategy and review; the off-mode '
    + 'dialog holder is the main agent with all four (after mori_team)', bad.length === 0
    && req.offDialog.every((item) => sectionNames(item)?.slice(-5)[0] === 'mori_team'), brief({ bad, view }));
}

/** @brief MEM-03：实例会话文件读回的分节（getCurrentSystemMessage）按 §5.1，身份段在 preamble 里。 */
function splitInstances(ctx, who) {
  const layers = layersOf(ctx, ctx.split);
  const files = instanceFiles(ctx, who.sessionId);
  const view = files.map((file) => {
    const meta = file.entries.find((entry) => entry.type === 'custom' && entry.customType === 'mori.instance')?.data;
    const seat = SEAT_OF_INSTANCE[meta?.kind];
    const got = fileSections(file.file);
    const want = seat ? expectedSections(seat, layers) : null;
    return { id: file.id.slice(who.sessionId.length + 1), kind: meta?.kind, seat,
      ok: Boolean(seat && got && same(got.memory, want)
        && identityHead(got.preamble) !== null),
      got: got?.memory.map((s) => s.name) };
  });
  const kinds = new Set(view.map((item) => item.kind));
  record('MEM-03 the instance session files (pi-ai getCurrentSystemMessage) hold the §5.1 sections for their seat and '
    + 'the identity section as preamble: create, close, task, both asks, subscription',
  ['create', 'close', 'task', 'ask', 'subscription'].every((kind) => kinds.has(kind))
    && view.filter((item) => item.kind === 'ask').length >= 2 && view.every((item) => item.ok), brief(view));
}

/** @brief MEM-11：每种会话有没有 memory，分开时对话调用 memory 被拒绝的原文。 */
function splitTools(ctx, who, req) {
  const has = (list) => list.length > 0 && list.every((item) => item.tools.includes('memory'));
  const none = (list) => list.length > 0 && list.every((item) => !item.tools.includes('memory'));
  record('MEM-11 off mode with a dialog role (chat holds the dialog, no tools field): the main agent has memory',
    has(req.offDialog), brief(req.offDialog.map((item) => item.tools)));
  const result = messagesOf(readJsonl(who.sessionFile).slice(1), 'toolResult').find((m) => m.toolName === 'memory');
  const text = contentText(result?.content);
  const saved = memoryFilesWith(ctx, MEM_PROMPT_TEXT.dialogAbstract);
  record('MEM-11 split team mode: the dialog\'s requests have no memory tool, and its memory call fails without saving '
    + 'anything (no file in either memory layer holds its abstract)',
  none(req.teamDialog) && result?.isError === true && saved.length === 0,
  brief({ tools: req.teamDialog.map((item) => item.tools), result: result && [result.isError, text], saved }));
  record(`MEM-11 split team mode: the dialog's memory call gets pi's tool result "${MEMORY_NOT_FOUND}" (§7.6: `
    + 'memory is not enabled, so pi refuses the call before the tool_call handlers)',
  result?.isError === true && text === MEMORY_NOT_FOUND, brief({ result: result && [result.isError, text] }));
  record('MEM-11 split team mode: the create instance has the memory tool', has(req.create),
    brief(req.create.map((item) => item.tools)));
  record('MEM-11 close, task, ask (team mode and off mode) and subscription requests have no memory tool',
    none(req.close) && none(req.task) && none(req.teamAsk) && none(req.offAsk) && none(req.sub),
    brief({ close: req.close[0]?.tools, task: req.task[0]?.tools, teamAsk: req.teamAsk[0]?.tools,
      offAsk: req.offAsk[0]?.tools, sub: req.sub[0]?.tools }));
  record('MEM-11 back in off mode the dialog holder has the memory tool again', has(req.backOff),
    brief(req.backOff.map((item) => item.tools)));
}

/** @brief MEM-02、MEM-04：模式切换那一次运行恰好一条补丁、<tools> 与请求一致，之后的运行没有补丁。 */
function splitPatches(who, req, t) {
  const firstTeam = req.firstTeam[0];
  const firstOff = req.backOff[0];
  const teamProblems = firstTeam ? identityProblems(firstTeam) : ['no request'];
  const offProblems = firstOff ? identityProblems(firstOff) : ['no request'];
  record('MEM-02 split config, team mode turned on: the dialog\'s first run has <tools> equal to the built-in tools in '
    + 'its request (read and ls: chat writes no tools, TaskBoard spec §8.1; no shell rule); the next runs in team '
    + 'mode (wake-up, second message) write no patch',
  teamProblems.length === 0 && listedTools(parsePrompt(firstTeam.system).tools)?.join() === 'read,ls'
    && t.n4 === t.n2, brief({ teamProblems, tools: firstTeam?.tools, n2: t.n2, n4: t.n4 }));
  record('MEM-02 split config, team mode turned off again: the first run\'s <tools> lists read, bash, edit, write and '
    + 'subagent as sent (with the bash rule); the second off-mode run writes no patch', offProblems.length === 0
    && sameSet(listedTools(parsePrompt(firstOff.system).tools) ?? [], ['read', 'bash', 'edit', 'write', 'subagent'])
    && t.n6 === t.n5, brief({ offProblems, tools: firstOff?.tools, n5: t.n5, n6: t.n6 }));
  record('MEM-04 each team-mode switch writes exactly one section patch at the start of the next run (on: dialog only '
    + 'taste; off: all four again) and the user session file\'s sections equal the last request\'s',
  t.n1 === 1 && t.n2 === 2 && t.n5 === 3 && fileMatches(who.sessionFile, req.backOff.at(-1)),
  brief({ n1: t.n1, n2: t.n2, n4: t.n4, n5: t.n5, n6: t.n6 }));
}

// ---------- 步骤 readonly：关闭模式下 chat.md 写 tools: [read] ----------

/** @brief chat.md 写 tools: [read] 的关闭模式对话（关键词模式）：<tools> 只有 read 与 subagent、没有 shell 规则、有 memory。 */
async function readonly(ctx) {
  const who = { tab: await openProject(ctx, ctx.readonly) };
  const s1 = await send(ctx, who, 'plain question one');
  const n1 = systemCount(who.sessionFile);
  await send(ctx, who, 'plain question two');
  const n2 = systemCount(who.sessionFile);
  const reqs = requestsOf(ctx, s1, (info) => info.role === 'chat' && info.kind === 'off-dialog');
  const problems = reqs[0] ? identityProblems(reqs[0]) : ['no request'];
  // 普通模式另有 subagent（docs/specs/subagent.md §2：Task mode 关闭时总有，对话持有者写了 tools: [read] 时也有）
  record('MEM-02 off mode with chat.md "tools: [read]": the first run\'s <tools> lists only read and subagent, as in '
    + 'the request\'s tools, and <rules> has no shell rule; the second run writes no patch', problems.length === 0
    && sameSet(reqs[0].tools, ['read', 'agent_message', 'memory', 'subagent'])
    && listedTools(parsePrompt(reqs[0].system).tools)?.join() === 'read,subagent' && n1 === 1 && n2 === 1,
  brief({ problems, tools: reqs[0]?.tools, n1, n2 }));
  record('MEM-11 off mode with chat.md "tools: [read]": the dialog holder still has the memory tool (Mori adds it '
    + 'after the role\'s tools)', reqs.length >= 2 && reqs.every((item) => item.tools.includes('memory')),
  brief(reqs.map((item) => item.tools)));
  const bad = reqs.flatMap((item) => sectionProblems(item, 'main', layersOf(ctx, ctx.readonly)));
  record('MEM-02 a kind with no entries in either layer has no section: with no project entries and no user-level '
    + 'REVIEW the request has taste, strategy and facts only (after mori_team)', reqs.length > 0 && bad.length === 0
    && same(requestMemory(reqs[0]).map((s) => s.name), ['taste', 'strategy', 'facts']), brief(bad));
}

// ---------- 步骤 system：项目的 .pi/SYSTEM.md ----------

/** @brief 受信任的项目有 .pi/SYSTEM.md（用户级也有）：都不进请求，日志记一次项目的那个文件。MEM-01。 */
async function system(ctx) {
  const opened = Date.now();
  const who = { tab: await openProject(ctx, ctx.sys, { trust: true }) };
  const s1 = await send(ctx, who, 'plain question in the project with SYSTEM.md');
  await send(ctx, who, 'plain second question');
  const reqs = requestsOf(ctx, s1);
  const logs = appLogLines(ctx, SYSTEM_LOG, opened);
  const file = join(ctx.sys, '.pi', 'SYSTEM.md');
  const problems = reqs.flatMap((item) => identityProblems(item));
  record('MEM-01 a trusted project .pi/SYSTEM.md is read by pi but not used: the requests start with Mori\'s identity '
    + `section and contain neither SYSTEM.md, and "${SYSTEM_LOG}<project file>" is logged once for the session`,
  reqs.length >= 2 && problems.length === 0 && reqs.every((item) => !item.system.includes(PROJECT_SYSTEM_MARK)
    && !item.system.includes(USER_SYSTEM_MARK)) && logs.length === 1 && logs[0].endsWith(`${SYSTEM_LOG}${file}`),
  brief({ logs, problems }));
}

// ---------- 步骤 guard：记忆目录的写保护 ----------

/** @brief 在页面里记下出现过的批准卡（window.__memCards：{ t, tool }）。 */
function watchCards(ctx) {
  return ctx.page.evaluate(() => {
    if (window.__memCards) return;
    window.__memCards = [];
    const seen = new WeakSet();
    const scan = () => {
      for (const el of document.querySelectorAll('[data-testid="approval-card"]')) {
        if (seen.has(el)) continue;
        seen.add(el);
        window.__memCards.push({ t: Date.now(), tool: el.dataset.tool ?? null });
      }
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true });
    scan();
  });
}

/** @brief watchCards 记下的批准卡（since 之后）。 */
const cardsSince = (ctx, since) => ctx.page.evaluate((from) => (window.__memCards ?? [])
  .filter((item) => item.t >= from), since);

/**
 * @brief 发一条调用工具的消息（关键词 "call tool: <名字> <JSON>"），出批准卡时按 approve 允许或拒绝，等会话空闲。
 * @return { since, cards（这次出现的批准卡）, result（会话文件里这次的工具结果：{ isError, text }） }
 */
async function callTool(ctx, who, tool, input, approve) {
  const since = Date.now();
  await sendMessage(ctx, who.tab, `call tool: ${tool} ${JSON.stringify(input)}`);
  if (!who.sessionFile) Object.assign(who, await userSession(ctx, who.tab));
  const card = ctx.page.locator(`${paneSel(who.tab)} [data-testid="approval-card"]`);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await card.count()) {
      await card.first().locator(`[data-testid="${approve ? 'approval-allow' : 'approval-reject'}"]`).click();
      await sleep(300);
    }
    const results = messagesOf(readJsonl(who.sessionFile).slice(1), 'toolResult');
    const done = results.length > (who.results ?? 0) && await waitTeamIdle(ctx, who, { timeout: 1500, stableMs: 800 });
    if (done) break;
    await sleep(200);
  }
  const results = messagesOf(readJsonl(who.sessionFile).slice(1), 'toolResult');
  who.results = results.length;
  const last = results.at(-1);
  return { since, cards: await cardsSince(ctx, since), result: last ? { tool: last.toolName, isError: last.isError,
    text: contentText(last.content) } : null };
}

/** @brief 记忆目录下（两层）内容含 text 的文件的相对路径。 */
function memoryFilesWith(ctx, text) {
  const root = memoryRoot(ctx);
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((item) => item.isFile())
    .map((item) => join(item.parentPath ?? item.path, item.name))
    .filter((file) => readFileSync(file, 'utf8').includes(text)).map((file) => relative(root, file));
}

/** @brief 记忆目录下的全部文件（相对路径与内容），比较写保护前后。 */
function memoryFiles(ctx) {
  const root = memoryRoot(ctx);
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((item) => item.isFile())
    .map((item) => join(item.parentPath ?? item.path, item.name))
    .map((file) => `${relative(root, file)}:${readFileSync(file, 'utf8').length}`).sort();
}

/** @brief 写保护要试的路径（§7.7：相对、/c/…、~、@ 前缀、只是大小写不同）；userData 不在 home 下时没有 ~ 那一种。 */
function guardPaths(ctx) {
  const target = (name) => join(userBase(ctx), name);
  const msys = (file) => `/${file[0].toLowerCase()}${file.slice(2).replaceAll('\\', '/')}`;
  const home = homedir();
  const inHome = relative(home, target('x')).startsWith('..') ? null : home;
  return [
    { name: 'relative path', path: relative(ctx.guard, target('mem13-relative.md')),
      file: target('mem13-relative.md') },
    { name: '/c/… path', path: msys(target('mem13-msys.md')), file: target('mem13-msys.md') },
    ...(inHome ? [{ name: '~ path', path: `~/${relative(home, target('mem13-tilde.md')).replaceAll('\\', '/')}`,
      file: target('mem13-tilde.md') }] : []),
    { name: '@ prefix', path: `@${target('mem13-at.md')}`, file: target('mem13-at.md') },
    { name: 'case-different path', path: target('mem13-case.md').toUpperCase(), file: target('mem13-case.md') },
  ];
}

/** @brief 关闭模式、每次询问的会话里 write、edit 写记忆目录（被拒绝）与兄弟目录、项目里（经批准写入）。MEM-13。 */
async function guard(ctx) {
  await watchCards(ctx);
  const who = { tab: await openProject(ctx, ctx.guard) };
  const before = memoryFiles(ctx);
  const taste = readFileSync(join(userBase(ctx), 'TASTE.md'), 'utf8');
  const blocked = [];
  for (const item of guardPaths(ctx)) {
    const out = await callTool(ctx, who, 'write', { path: item.path, content: 'written by a model (synthetic)\n' },
      false);
    blocked.push({ name: item.name, path: item.path, ...out, exists: existsSync(item.file) });
  }
  const edit = await callTool(ctx, who, 'edit', { path: join(userBase(ctx), 'TASTE.md'),
    edits: [{ oldText: '# TASTE', newText: '# CHANGED' }] }, false);
  blocked.push({ name: 'edit of TASTE.md', ...edit, exists: false });
  const bad = blocked.filter((item) => !(item.result?.isError === true && item.result.text === MEMORY_FILES_ONLY
    && item.cards.length === 0 && !item.exists));
  record('MEM-13 write and edit into <userData>/memory are refused with "Memory files can only be changed with the '
    + 'memory tool or on the Memory page." before any approval card, for a relative path, a /c/… path, a ~ path, an @ '
    + 'prefix, a path differing only in case, and an edit of user/TASTE.md; no file is written or changed',
  blocked.length >= 5 && bad.length === 0 && same(memoryFiles(ctx), before)
    && readFileSync(join(userBase(ctx), 'TASTE.md'), 'utf8') === taste,
  brief({ bad: bad.map((item) => ({ name: item.name, path: item.path, result: item.result, cards: item.cards,
    exists: item.exists })), tried: blocked.map((item) => item.name) }));
  await guardAllowed(ctx, who);
}

/** @brief MEM-13：<userData> 下前缀相同的兄弟目录与项目里的文件照常写（经批准）。 */
async function guardAllowed(ctx, who) {
  const sibling = join(`${memoryRoot(ctx)}-x`, 'mem13-sibling.md');
  const local = join(ctx.guard, 'mem13-elsewhere.txt');
  const out = [];
  for (const [name, path, file] of [['sibling <userData>/memory-x', sibling, sibling],
    ['project file', 'mem13-elsewhere.txt', local]]) {
    const result = await callTool(ctx, who, 'write', { path, content: 'allowed (synthetic)\n' }, true);
    out.push({ name, ...result, exists: existsSync(file) });
  }
  record('MEM-13 the sibling folder <userData>/memory-x (same prefix) and a project file are written as usual, after '
    + 'the approval card', out.every((item) => item.cards.length === 1 && item.result?.isError === false
    && item.exists), brief(out.map((item) => ({ name: item.name, cards: item.cards.length, result: item.result,
    exists: item.exists }))));
}

// ---------- 步骤 checkAgain：Check again 之后重新建立的会话 ----------

/** @brief 拒绝启动卡的种类；没有卡时为 null。 */
const blockedKind = (ctx, tab) => ctx.page.locator(`${paneSel(tab)} [data-testid="blocked-card"]`).first()
  .getAttribute('data-kind', { timeout: 2000 }).catch(() => null);

/** @brief 角色文件有问题的会话打开后在记忆页加一条，改好文件、Check again，下一次请求有这一条。MEM-04。 */
async function checkAgain(ctx) {
  const who = { tab: await openProject(ctx, ctx.invalid) };
  const blocked = await poll(() => blockedKind(ctx, who.tab), 15000);
  await addEntryOnPage(ctx, who.tab, { scope: 'project', section: 'taste', abstract: E2 });
  writeRole(ctx.invalid, { name: 'executor', description: 'Changes code and runs commands to finish a task' });
  await showTab(ctx, who.tab);
  await ctx.page.locator(`${paneSel(who.tab)} [data-testid="blocked-card"] button[data-action="check-agents"]`)
    .click();
  const cleared = await poll(async () => (await blockedKind(ctx, who.tab)) === null, 20000);
  const s1 = await send(ctx, who, 'plain question after Check again');
  const reqs = requestsOf(ctx, s1);
  const bad = reqs.flatMap((item) => sectionProblems(item, 'main', layersOf(ctx, ctx.invalid, { e2: true })));
  record('MEM-04 after Check again the session is set up again and reads the entries anew: an entry added on the '
    + 'Memory page while the session was refused (agents_invalid) is in the next request',
  blocked === 'agents_invalid' && cleared && reqs.length > 0 && bad.length === 0
    && reqs.every((item) => item.system.includes(`- ${E2}`)), brief({ blocked, cleared, bad }));
}

// ---------- 步骤 enhance：增强会话 ----------

/** @brief 一次增强运行（现在运行）的三个任务都有了结果。 */
const enhanceDone = (info) => info && !info.running && info.queued === 0
  && ['taste', 'strategy', 'review'].every((task) => info.last?.[task]);

/** @brief 打开增强、现在运行（增强脚本只回一句）：三个增强会话的请求都有身份段，关闭模式下是主 Agent。MEM-01、MEM-03。 */
async function enhance(ctx) {
  const who = { tab: await openProject(ctx, ctx.enh) };
  await send(ctx, who, 'plain hello for the enhancement');
  const since = Date.now();
  const set = await bridge(ctx, { type: 'enhance.set', cwd: ctx.enh, enabled: true });
  const run = await bridge(ctx, { type: 'enhance.run', cwd: ctx.enh });
  const info = await poll(async () => {
    const now = await bridge(ctx, { type: 'enhance.get', cwd: ctx.enh });
    return enhanceDone(now) ? now : null;
  }, 180000, 500);
  const reqs = requestsOf(ctx, since, (_, item) => item.messages.some((m) => m.role === 'user'
    && contentText(m.content).startsWith(ENHANCE_FIRST)));
  const kinds = new Set(reqs.map((item) => /daily (\w+) enhancement/.exec(item.messages
    .map((m) => contentText(m.content)).find((text) => text.startsWith(ENHANCE_FIRST)) ?? '')?.[1]));
  const problems = reqs.flatMap((item) => identityProblems(item));
  record('MEM-01 the enhancement sessions (TASTE, STRATEGY, REVIEW, run now) have the identity section with <tools> '
    + 'and <rules> matching their tools', !set?.error && !run?.error && Boolean(info) && kinds.size === 3
    && problems.length === 0, brief({ set: set?.error, run: run?.error, last: info?.last, kinds: [...kinds],
    problems }));
  const bad = reqs.flatMap((item) => sectionProblems(item, 'main', layersOf(ctx, ctx.enh)));
  record('MEM-03 an enhancement session with team mode off is a main agent (§5.1): its requests have every kind with '
    + 'entries (taste, strategy, facts; no REVIEW entry exists)', reqs.length >= 3 && bad.length === 0,
  brief({ bad: bad.slice(0, 3), names: reqs.map(sectionNames).slice(0, 1) }));
}

// ---------- 步骤 restart：重启 App 后重新打开协作模式的会话 ----------

/** @brief 重启 App，重新打开仍在协作模式的合并会话：新版条目、<tools> 一致、没有补丁；关掉协作模式后又有 memory。 */
async function restart(ctx) {
  const who = ctx.main;
  if (!who?.sessionFile) throw new Error('the prompt step did not run');
  await restartTbApp(ctx);
  who.tab = await reopenSession(ctx, who.sessionFile);
  const mode = (await teamSwitch(ctx, who.tab)).mode;
  const t = {};
  t.s6 = await send(ctx, who, 'Team question after the restart');
  t.n6 = systemCount(who.sessionFile);
  t.s7 = await send(ctx, who, 'Second team question after the restart');
  t.n7 = systemCount(who.sessionFile);
  await clickTeamSwitch(ctx, who.tab, 'off');
  t.s8 = await send(ctx, who, 'Off question after the restart');
  t.n8 = systemCount(who.sessionFile);
  t.s9 = await send(ctx, who, 'Second off question after the restart');
  t.n9 = systemCount(who.sessionFile);
  const team = requestsOf(ctx, t.s6, (info) => info.kind === 'merged-create', t.s8);
  const off = requestsOf(ctx, t.s8, (info) => info.kind === 'dialog');
  const layers = layersOf(ctx, ctx.plain, { e1: true });
  // 重新打开的会话里各段的先后按会话文件里的补丁重放（§5.3），只比较内容
  const bad = [...team.flatMap((item) => sectionProblems(item, 'merged', layers, false)),
    ...off.flatMap((item) => sectionProblems(item, 'main', layers, false))];
  record('MEM-04 a session reopened after restarting Mori uses the new version: the Memory page entry added after it '
    + 'first opened is now in its requests (team mode and back in off mode)', mode === 'always' && team.length > 0
    && off.length > 0 && bad.length === 0 && [...team, ...off].every((item) => item.system.includes(`- ${E1}`)),
  brief({ mode, bad }));
  const teamProblems = team[0] ? identityProblems(team[0]) : ['no request'];
  const offProblems = off[0] ? identityProblems(off[0]) : ['no request'];
  record('MEM-02 a team-mode session reopened after a restart: the first run\'s <tools> matches the request\'s tools '
    + 'and the second run writes no patch; turned off, the first run matches again and the second writes no patch',
  teamProblems.length === 0 && t.n7 === t.n6 && offProblems.length === 0 && t.n9 === t.n8,
  brief({ teamProblems, offProblems, ...t }));
  record('MEM-11 the merged session back in off mode has the memory tool again',
    off.length > 0 && off.every((item) => item.tools.includes('memory')), brief(off.map((item) => item.tools)));
}

// ---------- 整个套件的检查 ----------

/** @brief MEM-01、MEM-02：本套件的每一个对话请求都以身份段开头，不含 SYSTEM.md 与读不出来的条目。 */
function suiteChecks(ctx) {
  const all = scenarioRequests(ctx.ep, null);
  const bad = all.filter((item) => identityProblems(item).length > 0)
    .map((item) => `${item.info.role}/${item.info.kind}: ${identityProblems(item)[0]}`);
  record('MEM-01 every chat request of this suite (user, instance and enhancement sessions) starts with the identity '
    + 'section and its <tools>/<rules> match the tools sent', all.length > 20 && bad.length === 0,
  brief({ requests: all.length, bad: bad.slice(0, 5) }));
  const leaked = all.filter((item) => item.system.includes('MEMP-BROKEN') || item.system.includes(USER_SYSTEM_MARK)
    || item.system.includes(PROJECT_SYSTEM_MARK));
  record('MEM-02 no request of this suite contains an unreadable entry\'s abstract or either SYSTEM.md',
    all.length > 0 && leaked.length === 0, brief(leaked.map((item) => `${item.info.role}/${item.info.kind}`)));
}

// ---------- MEM-37：mori-memory 载入失败时会话不打开 ----------

/** 拷贝里被换掉的一行（mori-memory 工厂函数注册 memory 工具的地方，memoryExtension.ts） */
const MEMORY_FACTORY_LINE = 'if (setup.tool) pi.registerTool(memoryTool(setup.tool));';
/** 换上的一行（synthetic fault injection） */
const MEMORY_FACTORY_FAULT = 'throw new Error("synthetic fault injection by mem-app-prompt: mori-memory cannot load");';

/** @brief 把当前构建拷到 .tb-runs/mem-memfail，只在拷贝的内核代码里让 mori-memory 的工厂函数抛错。 */
function faultyBuild() {
  const from = process.env.MORI_APP_DIR ? resolve(process.env.MORI_APP_DIR) : appRoot;
  const dir = join(appRoot, '.tb-runs', 'mem-memfail');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(from, 'out'), join(dir, 'out'), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8'));
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: pkg.name, version: pkg.version, main: pkg.main,
    type: pkg.type }, null, 2)}\n`);
  const kernel = join(dir, 'out', 'main', 'kernel.js');
  const code = readFileSync(kernel, 'utf8');
  if (code.split(MEMORY_FACTORY_LINE).length !== 2) {
    throw new Error(`cannot find the mori-memory factory line in ${kernel}`);
  }
  writeFileSync(kernel, code.replace(MEMORY_FACTORY_LINE, MEMORY_FACTORY_FAULT));
  return dir;
}

/** @brief 目录下的全部文件（递归）；不存在时为 []。 */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((item) => item.isFile())
    .map((item) => item.name);
}

/** @brief 用拷贝启动 Mori（新的数据目录），打开一个项目：会话不打开，界面写明原因。打包版（--exe）不跑这一步。 */
async function memFail(ctx) {
  if (args.exePath) return;
  const dir = faultyBuild();
  const saved = process.env.MORI_APP_DIR;
  process.env.MORI_APP_DIR = dir;
  const fctx = { userData: tempUserData('mori-mem-prompt-fail-'), exePath: null };
  seedTeamUserData(fctx.userData, ctx.seed);
  try {
    await startTbApp(fctx);
    const project = tempProject('mori-mem-prompt-fail-');
    await stubFolder(fctx.app, project);
    await fctx.page.getByRole('button', { name: /^Open folder…$/ }).first().click();
    const failed = await poll(() => fctx.page.evaluate(() => [...document.querySelectorAll('[role="alert"], '
      + '.form-message.error')].map((el) => el.textContent)
      .find((text) => text.includes('Failed to open session: ')) ?? null), 30000);
    await sleep(1000);
    const sessions = filesUnder(join(fctx.userData, 'pi', 'sessions'));
    const ready = await fctx.page.locator('[data-testid="chat-pane"] [data-testid="not-ready"]').allTextContents();
    record('MEM-37 when mori-memory fails to load (fault injected into a copy of the build) the session does not open: '
      + '"Failed to open session: The memory extension failed to load: …" is shown, the pane stays "Session didn’t '
      + 'open" and no session file is written', typeof failed === 'string'
      && failed.includes('Failed to open session: The memory extension failed to load: ')
      && failed.includes('synthetic fault injection') && sessions.length === 0
      && ready.every((text) => text === 'Session didn’t open'), brief({ failed, sessions, ready }));
  } finally {
    writeFileSync(join(args.shots, 'memfail-app.log'), fctx.appLog?.map((item) => item.line).join('\n') ?? '');
    await closeTbApp(fctx);
    if (saved === undefined) delete process.env.MORI_APP_DIR;
    else process.env.MORI_APP_DIR = saved;
  }
}

// ---------- 主流程 ----------

/** 按顺序跑的步骤（后面的步骤用前面打开的会话：toolsPage、snapshot、merged、restart 要 prompt 的会话） */
const steps = { prompt, toolsPage, snapshot, merged, split, readonly, system, guard, checkAgain, enhance, restart };

const ctx = { userData: tempUserData('mori-mem-prompt-data-'), exePath: args.exePath, pageErrors: [] };
try {
  await setup(ctx);
  for (const [name, step] of Object.entries(steps)) {
    if (args.only && !args.only.includes(name)) continue;
    console.log(`[mem-app-prompt] step ${name}`);
    try {
      await step(ctx);
    } catch (error) {
      record(`${name}: mem-app-prompt`, false, oneLineError(error));
      await shot(ctx, args, `${name}-error`);
    }
  }
  if (!args.only) suiteChecks(ctx);
  const missing = missingSteps(ctx.ep);
  record('mem-app-prompt: the synthetic endpoint got no request that the scripts did not expect', missing.length === 0,
    brief(missing.map((item) => item.line).slice(0, 5)));
} catch (error) {
  record('setup: mem-app-prompt', false, oneLineError(error));
} finally {
  record('page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  writeFileSync(join(args.shots, 'app.log'), ctx.appLog?.map((item) => item.line).join('\n') ?? '');
  await closeTbApp(ctx);
}
if (!args.only || args.only.includes('memFail')) {
  console.log('[mem-app-prompt] step memFail');
  try {
    await memFail(ctx);
  } catch (error) {
    record('memFail: mem-app-prompt', false, oneLineError(error));
  }
}
await stopTbEndpoint(ctx.ep);
console.log(`[mem-app-prompt] data in ${ctx.userData}`);
finish();
