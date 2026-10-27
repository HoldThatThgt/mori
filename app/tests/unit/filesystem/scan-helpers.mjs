// 命令分析单元测试（docs/specs/file-system-permissions.md §7.9，docs/specs/file-system.md §19.2 的 FS-42…FS-50）共用的工具：
// 载入 kernel/commandScan.ts，§7.9 的记号（P、W、T 与 vars），期望的写法（写、看不出来、离、败、无），
// 表的行属于哪些验收条目（§19.2；一行属于两个条目时各跑一次），以及按行注册测试。
// 期望逐字照 §7.9 的表；表里没写出的 text 按 §7.2 的规则（命令里的原文，去掉引号与转义后）写出。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import { loadKernelModule } from '../load.mjs';

/** kernel/commandScan.ts 的导出 */
export const scanModule = await loadKernelModule('src/kernel/commandScan.ts');

/** §7.9 的记号：工作路径 P */
export const P = 'C:\\w\\proj';
/** §7.9 的记号：W 是 P 的上级 */
export const W = 'C:\\w';
/** §7.9 的记号：vars 的 TEMP、TMP、TMPDIR 都是 T */
export const T = 'C:\\w\\proj\\.work\\tmp';

/** 写入的标记：删除（remove 为真） */
export const DEL = 'del';
/** 写入的标记：落进目录（into 为真） */
export const INTO = 'into';

/** @brief P 下的路径（不给参数时是 P 本身）。 */
export function p(...parts) {
  return parts.length === 0 ? P : win32.join(P, ...parts);
}

/** @brief W 下的路径（不给参数时是 W 本身）。 */
export function w(...parts) {
  return parts.length === 0 ? W : win32.join(W, ...parts);
}

/** @brief T 下的路径（不给参数时是 T 本身）。 */
export function t(...parts) {
  return parts.length === 0 ? T : win32.join(T, ...parts);
}

/** @brief 一个工作路径的 vars（同 workspace.workVars：TEMP、TMP、TMPDIR → <cwd>\.work\tmp，§7.2、§7.11）。 */
export function varsOf(cwd) {
  const tmp = win32.join(cwd, '.work', 'tmp');
  return Object.freeze({ TEMP: tmp, TMP: tmp, TMPDIR: tmp });
}

/**
 * @brief 看得出路径的写入（§7.9 的“写 形式 路径”，“删”“入”用 DEL、INTO）。
 * @param form 写法
 * @param text 命令里的原文（去掉引号与转义后）
 * @param path 解析后的绝对路径
 * @param flags DEL、INTO
 */
export function wr(form, text, path, ...flags) {
  return { form, text, path, unknown: null, remove: flags.includes(DEL), into: flags.includes(INTO) };
}

/**
 * @brief 看不出来的写入（§7.9 的“写 形式 ?原因”）：path 为 null，into 为假。
 * @param form 写法
 * @param text 命令里的原文
 * @param why 原因（§7.6）
 * @param flags DEL
 */
export function wq(form, text, why, ...flags) {
  return { form, text, path: null, unknown: why, remove: flags.includes(DEL), into: false };
}

/** @brief 一条 leave（§7.9 的“离 形式 目录 命令”；目录看不出来时 dir 为 null）。 */
export function lv(form, text, dir, command) {
  return { form, text, dir, command };
}

/** @brief ok: true 的结果。 */
export function ok(writes = [], leaves = []) {
  return { ok: true, writes, leaves };
}

/** @brief §7.9 的“无”：ok: true 且两个列表都空。 */
export const NONE = Object.freeze(ok());

/** @brief §7.9 的“败 原因”。 */
export function fail(reason) {
  return { ok: false, reason };
}

/**
 * @brief 分析一条命令（vars 取这个工作路径的 workVars）。
 * @param shell 'bash' 或 'powershell'
 * @param command 命令文字
 * @param cwd 工作路径（默认 P）
 */
export function scan(shell, command, cwd = P) {
  return scanModule.scanCommand({ command, shell, cwd, vars: varsOf(cwd) });
}

/**
 * §19.2 里每个条目逐行跑的 §7.9 行（编号的范围，含两端；B42a 这类带字母的行按数字落进范围，FS-47 另列 B42a–B42c）。
 * 范围按 B / S 前缀与数字比较；带字母的单独列出时只认那一行。
 */
const ITEM_ROWS = [
  ['FS-42', ['B1-B13', 'B34', 'B46-B61', 'B89']],
  ['FS-43', ['B14-B33', 'B118']],
  ['FS-44', ['B34-B45', 'B85', 'B91']],
  ['FS-45', ['S1-S21', 'S37-S46', 'S55-S60']],
  ['FS-46', ['S22-S27']],
  ['FS-47', ['B62-B85', 'B42a', 'B42b', 'B42c', 'S24a', 'S47-S51']],
  ['FS-48', ['B92-B114', 'S28-S36']],
  ['FS-49', ['B76-B78', 'B80-B84', 'B86-B88', 'B115', 'B116', 'B117', 'S47', 'S50', 'S52-S54', 'S58-S60']],
  ['FS-50', ['B90', 'B106', 'B108', 'B114']],
];

/** @brief 行号拆成前缀、数字与字母（B42a → ['B', 42, 'a']）。 */
function parseRow(id) {
  const match = /^([BS])(\d+)([a-z]?)$/.exec(id);
  assert.ok(match, `bad row id ${id}`);
  return [match[1], Number(match[2]), match[3]];
}

/** @brief 一行落不落在一个范围里（'B1-B13' 或单独的 'B42a'）。 */
function inRange(id, range) {
  const [prefix, number, letter] = parseRow(id);
  const [from, to] = range.split('-');
  const [fromPrefix, fromNumber, fromLetter] = parseRow(from);
  if (to === undefined) return prefix === fromPrefix && number === fromNumber && letter === fromLetter;
  const [, toNumber] = parseRow(to);
  return prefix === fromPrefix && number >= fromNumber && number <= toNumber;
}

/** @brief 一行属于哪些验收条目（§19.2）；属于两个条目的行用同一份期望各跑一次（§7.9）。 */
export function itemsOf(id) {
  return ITEM_ROWS.filter(([, ranges]) => ranges.some((range) => inRange(id, range))).map(([item]) => item);
}

/** @brief 测试名里的命令：换行写 ⏎、tab 写 ⇥、\r 写 \r，过长的截断。 */
export function label(command) {
  const text = command.replace(/\r/g, '\\r').replace(/\n/g, '⏎').replace(/\t/g, '⇥');
  return text.length > 90 ? `${text.slice(0, 87)}...` : text;
}

/**
 * @brief §7.9 的一行。
 * @param id 编号（B12、S24a）
 * @param command 命令文字（或生成它的函数，B115、B116 那样很长的）
 * @param expect 期望的 ScanResult
 * @param options { cwd: 工作路径（默认 P）, title: 测试名里代替命令的说明 }
 */
export function row(id, command, expect, options = {}) {
  return { id, command, expect, cwd: options.cwd ?? P, title: options.title ?? null };
}

/**
 * @brief 按 §7.9 的表注册测试：每行在它所属的每个条目下各一个测试，名字为 "<条目> <行号> <命令>"。
 * @param shell 'bash' 或 'powershell'
 * @param rows row() 的列表
 */
export function tableTests(shell, rows) {
  for (const entry of rows) {
    const items = itemsOf(entry.id);
    assert.ok(items.length > 0, `row ${entry.id} belongs to no acceptance item`);
    for (const item of items) {
      const name = entry.title ?? label(typeof entry.command === 'string' ? entry.command : entry.command());
      test(`${item} ${entry.id} ${name}`, () => {
        const command = typeof entry.command === 'string' ? entry.command : entry.command();
        assert.deepEqual(scan(shell, command, entry.cwd), entry.expect);
      });
    }
  }
}

/**
 * @brief 一组命令各自的期望（表外的补充用例，§19.2 的“至少一行”）：每条一个断言，失败时带上命令。
 *        每条都跑完再报告：一条失败不挡住后面的，几条失败时一起列出（每条带命令与差异）。
 * @param shell 'bash' 或 'powershell'
 * @param cases [命令, 期望] 的列表；期望可以是函数（收到结果，自己断言）
 * @param cwd 工作路径（默认 P）
 */
export function expectAll(shell, cases, cwd = P) {
  const failures = [];
  for (const [command, expect] of cases) {
    try {
      const result = scan(shell, command, cwd);
      if (typeof expect === 'function') expect(result, command);
      else assert.deepEqual(result, expect, label(command));
    } catch (error) {
      failures.push({ command, error });
    }
  }
  if (failures.length === 1) throw failures[0].error;
  if (failures.length > 1) {
    const lines = failures.map(({ command, error }) => `[${label(command)}]\n${error.message}`);
    assert.fail(`${failures.length} of ${cases.length} cases failed:\n\n${lines.join('\n\n')}`);
  }
}

/** @brief 结果里的 leave（ok 为假时断言失败）。 */
export function leavesOf(result, command = '') {
  assert.equal(result.ok, true, `${label(command)}: ${result.reason ?? ''}`);
  return result.leaves;
}

/** @brief 结果里的写入（ok 为假时断言失败）。 */
export function writesOf(result, command = '') {
  assert.equal(result.ok, true, `${label(command)}: ${result.reason ?? ''}`);
  return result.writes;
}

/**
 * §7.7 git 的只读子命令（两边一样），另加带条件的 branch、remote、stash list、config 与没有子命令的 git；
 * 每项是整条 git 命令
 */
export const GIT_READ_ONLY = [
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'blame', 'grep', 'describe',
  'shortlog', 'merge-base', 'name-rev', 'rev-list', 'for-each-ref', 'show-ref', 'version', 'help',
  'branch', 'branch -a -r -v -vv -l --list --all --remotes --show-current', 'remote', 'remote -v', 'stash list',
  'config --get user.name', 'config --get-all x', 'config --list', 'config -l', 'config --show-origin --list',
].map((sub) => `git ${sub}`).concat(['git']);

/** §7.7 git 只读名单里的子命令（READ_ONLY_COMMANDS.git 应与它相同） */
export const GIT_READ_ONLY_NAMES = GIT_READ_ONLY.slice(0, 19).map((command) => command.slice(4));

/** @brief 把一段文字重复到不超过 1,000,000 个字符（FS-49 的 1 MB 命令）；前后可以接固定的文字。 */
export function megabyte(unit, prefix = '', suffix = '') {
  const room = scanModule.SCAN_MAX_CHARS - prefix.length - suffix.length;
  return prefix + unit.repeat(Math.floor(room / unit.length)) + suffix;
}

/**
 * @brief 分析一次所用的时间（毫秒）：本线程的 CPU 时间（user + system）与墙上时间；结果不是 ok 时断言失败。
 *        node --test 让几个测试文件在各自的进程里并行运行，机器忙时墙上时间含等待调度的时间，CPU 时间才是分析本身的耗时。
 */
function timeOnce(shell, command, name) {
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  const result = scan(shell, command);
  const wall = performance.now() - start;
  const used = process.threadCpuUsage(cpu);
  assert.equal(result.ok, true, `${name}: ${result.reason ?? ''}`);
  return { cpu: (used.user + used.system) / 1000, wall };
}

/** 一个形状超过 500 ms 时最多量几次（取最快的一次） */
const TIME_ATTEMPTS = 8;

/** 两次计时之间停多久（毫秒）：test:fs-unit 的十几个测试文件同时跑，CPU 降频、超线程争用时线程 CPU 时间会被拉长几倍 */
const TIME_PAUSE_MS = 400;

/** @brief 同步地停一会儿（不占 CPU），让同时跑的别的测试文件先跑完。 */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @brief FS-49 的计时：先热身一次，再逐个分析 1 MB 的命令，CPU 时间超过 500 ms 的列出来（期望为空）。超过的停一会儿再量，
 *        最多 TIME_ATTEMPTS 次、取最快的一次（偶然的停顿、垃圾回收与别的测试文件同时跑时的争用不算，分析本身慢的每次都超过）；
 *        列出的项带上墙上时间。
 * @param shell 'bash' 或 'powershell'
 * @param shapes [名字, 生成命令的函数] 的列表
 * @param warm 热身用的短命令
 */
export function timeShapes(shell, shapes, warm) {
  scan(shell, warm);
  const slow = [];
  for (const [name, make] of shapes) {
    const command = make();
    assert.ok(command.length <= scanModule.SCAN_MAX_CHARS && command.length > 990_000, `${name}: ${command.length}`);
    let time = timeOnce(shell, command, name);
    for (let attempt = 1; attempt < TIME_ATTEMPTS && time.cpu > 500; attempt += 1) {
      pause(TIME_PAUSE_MS);
      const again = timeOnce(shell, command, name);
      if (again.cpu < time.cpu) time = again;
    }
    if (time.cpu > 500) slow.push(`${name}: ${Math.round(time.cpu)} ms CPU (${Math.round(time.wall)} ms wall)`);
  }
  assert.deepEqual(slow, []);
}

/** @brief 按 JSON 排序后比较两个列表（结果里几个可能的顺序、或名单的顺序规格没定时用）。 */
export function sameSet(actual, expected, message) {
  const order = (list) => list.map((item) => JSON.stringify(item)).sort();
  assert.deepEqual(order(actual), order(expected), message);
}

/**
 * @brief 给 expectAll 的期望：ok 为真，writes 与 leaves 各自按集合比较（规格没定它们之间的顺序时用，
 *        例如同一次 git 调用的 -C 与前缀的 GIT_DIR=：§7.2 只说按命令文字的顺序，§7.7 没定一条命令里几条 leave 的先后）。
 */
export function okAnyOrder(writes = [], leaves = []) {
  return (result, command) => {
    sameSet(writesOf(result, command), writes, label(command));
    sameSet(leavesOf(result, command), leaves, label(command));
  };
}
