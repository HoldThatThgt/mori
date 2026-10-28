// Git Bash 命令里与变量、环境相关的只读判断（docs/specs/file-system-permissions.md §7.4、§7.7 末尾与“审查后补”）：
// export / declare / local / readonly / typeset、read、set、printf -v / wait -p、env 包装，以及安全变量名单与 rg 的 --pre。
// 从 commandScanBash.ts 搬出来，让它不超过 2000 行；只被 commandScanBash.ts 与 commandScanPs.ts 调用，只以类型引用 commandScan.ts。

import type { Arg, GitEnv, GitName, Scan } from './commandScan';

// ---- 名单与共用判断 ----

/**
 * @brief 命令给它们设值时仍算只读命令的变量（§7.7 末尾第 5 条；照 Claude Code 文档 permissions 的例子 NODE_ENV、LANG=C、
 *        NO_COLOR=1，加上 TZ，临时默认值）；以 LC_ 开头的同样。按大写比较（Windows 的环境变量不分大小写）。
 */
export const SAFE_VARIABLES: readonly string[] = ['LANG', 'NO_COLOR', 'NODE_ENV', 'TZ'];

/** @brief 命令设、清掉、导出、声明、读进或循环取值都让它不是只读命令的变量（§7.7 末尾第 6 条，照 Claude Code 文档）。 */
export const SPECIAL_VARIABLES: readonly string[] = ['PATH', 'IFS'];

/** @brief SAFE_VARIABLES（大写）。 */
const SAFE_NAMES: ReadonlySet<string> = new Set(SAFE_VARIABLES);

/** @brief 名字是安全的环境变量（SAFE_VARIABLES 或以 LC_ 开头，不分大小写）。 */
export function isSafeName(name: string): boolean {
  const upper = name.toUpperCase();
  return SAFE_NAMES.has(upper) || upper.startsWith('LC_');
}

/** @brief rg 的 --pre / --pre=… / --pre-glob（§7.7 末尾“审查后补”第 7 条）让 rg 不是只读命令。 */
export function rgPre(values: readonly string[]): boolean {
  return values.some((value) => /^--pre(?:-glob)?(?:=|$)/.test(value));
}

// ---- 常量 ----

/** @brief 开头的 名字=值、名字+=值、名字[下标]=值（§7.4）。 */
export const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/;
/** @brief 命令改过之后看不出来的四个变量。 */
export const WORK_NAMES: ReadonlySet<string> = new Set(['TEMP', 'TMP', 'TMPDIR', 'PWD']);
/** @brief git 认的两个环境变量。 */
export const GIT_NAMES: ReadonlySet<string> = new Set(['GIT_DIR', 'GIT_WORK_TREE']);
/** @brief env -i 清掉的变量里要看的：四个变量（看不出来），PATH（不是只读命令，§7.7 末尾第 6 条）。 */
const CLEARED: readonly string[] = [...WORK_NAMES, 'PATH'];
/** @brief read 带值的短选项（-a 的值是数组变量目标，其余的值不是变量名）。 */
const READ_VALUE_OPTIONS = 'adinNptu';

// ---- shell 变量赋值（只有赋值、export 这类，§7.4） ----

/** @brief 四个变量从此看不出来，CDPATH 记下，GIT_DIR / GIT_WORK_TREE 按 export。 */
export function shellVar(scan: Scan, name: string, value: Arg): void {
  if (WORK_NAMES.has(name)) scan.markVar(name);
  if (name === 'CDPATH') scan.cdpath = true;
  if (GIT_NAMES.has(name)) scan.gitEnv.set(name as GitName, { arg: value, shell: 'bash' });
}

/**
 * @brief export / declare / local / readonly / typeset 的参数（§7.4、§7.7 末尾“审查后补”第 1 条）：选项里有 nameref（`-n`）
 *        时不是只读命令；`名字=值` 是设值；只有名字（不带值）时名字不在安全名单里（含看不出名字）就不是只读命令。
 * @param args 整条命令（含命令名）
 */
export function declareArgs(scan: Scan, args: readonly Arg[]): void {
  for (const arg of args.slice(1)) {
    const text = scan.optionText(arg);
    if (text !== null && /^[-+]/.test(text)) {
      if (/^-[^-]*n/.test(text)) scan.notReadOnly();
      continue;
    }
    const match = text === null ? null : ASSIGNMENT.exec(text);
    if (!match) scan.declareVar(text);
    else {
      scan.setsVar(match[1]);
      shellVar(scan, match[1], scan.slice(arg, match[0].length));
    }
  }
}

// ---- read（§7.4、§7.7 末尾“审查后补”第 3、4 条） ----

/** @brief 一个变量目标：标出 WORK 变量（路径追踪）、PATH / IFS（第 6 条），env-like 或看不出名字时不是只读命令（第 3、4 条）。 */
function readTarget(scan: Scan, name: string | null): void {
  if (name !== null) scan.markVar(name);
  scan.envVar(name);
}

/** @brief read 的一个短选项组：返回下一个词的用途（数组名、跳过的值，或都不是）；-a 的内联名字（`-aNAME`）就地处理。 */
function readOption(scan: Scan, text: string): 'array' | 'skip' | null {
  for (let p = 1; p < text.length; p += 1) {
    const c = text[p];
    if (!READ_VALUE_OPTIONS.includes(c)) continue;
    const inline = text.slice(p + 1);
    if (c === 'a') {
      if (inline !== '') readTarget(scan, inline);
      return inline === '' ? 'array' : null;
    }
    return inline === '' ? 'skip' : null;
  }
  return null;
}

/** @brief read 读进的变量目标（操作数与 -a 的数组名）：按 readTarget 判断；跳过选项与它们的值。 */
export function readVars(scan: Scan, args: readonly Arg[]): void {
  let pending: 'array' | 'skip' | null = null;
  let operands = false;
  for (let k = 1; k < args.length; k += 1) {
    const arg = args[k];
    const name = scan.valueOf(arg) === null ? null : scan.valueOrText(arg);
    if (pending === 'array') { pending = null; readTarget(scan, name); continue; }
    if (pending === 'skip') { pending = null; continue; }
    const text = scan.optionText(arg);
    if (!operands && text === '--') { operands = true; continue; }
    if (!operands && text !== null && /^-[^-]/.test(text)) { pending = readOption(scan, text); continue; }
    operands = true;
    readTarget(scan, name);
  }
}

// ---- set（§7.7 末尾“审查后补”第 2 条） ----

/** @brief `set -a` / `set -o allexport` / `set -k` / `set -o keyword` 打开自动导出或关键字模式：不是只读命令。 */
export function setOptions(scan: Scan, args: readonly Arg[]): void {
  for (let k = 1; k < args.length; k += 1) {
    const value = scan.valueOrText(args[k]);
    if (value === '-o' || value === '+o') {
      const next = k + 1 < args.length ? scan.valueOrText(args[k + 1]) : '';
      if (next === 'allexport' || next === 'keyword') scan.notReadOnly();
      k += 1;
    } else if (/^-[A-Za-z]*[ak]/.test(value)) scan.notReadOnly();
  }
}

// ---- printf -v / wait -p（§7.7 末尾“审查后补”第 3 条） ----

/** @brief printf 的 `-v 名字` 或 wait 的 `-p 名字` 的变量目标：按 envVar 判断（看不出名字时也不是只读命令）。 */
export function varTargetOption(scan: Scan, args: readonly Arg[], letter: 'v' | 'p'): void {
  for (let k = 1; k < args.length; k += 1) {
    const text = scan.optionText(args[k]);
    if (text === null || !/^-[^-]/.test(text)) continue;
    const at = text.indexOf(letter);
    if (at < 0) continue;
    const inline = text.slice(at + 1);
    if (inline !== '') { scan.envVar(inline); return; }
    const next = args[k + 1];
    scan.envVar(next !== undefined && scan.valueOf(next) !== null ? scan.valueOrText(next) : null);
    return;
  }
}

// ---- env 包装（§7.4） ----

/** @brief env 的一个选项（单独的 - 同 -i）；返回用掉几个词。 */
function envOption(scan: Scan, value: string, next: string, scoped: string[]): number {
  if (value === '-') {
    scoped.push(...CLEARED);
    return 1;
  }
  if (value.startsWith('--')) {
    const eq = value.indexOf('=');
    const name = value.slice(2, eq < 0 ? undefined : eq);
    if (name === 'ignore-environment') scoped.push(...CLEARED);
    if (name === 'unset') scoped.push(eq < 0 ? next : value.slice(eq + 1));
    return scan.longOption(value, 'env');
  }
  const found = scan.cluster(value, 'uCS');
  if (found.option === 'C' || found.option === 'S') scan.fail(`unsupported option -${found.option}`);
  if (found.flags.includes('i')) scoped.push(...CLEARED);
  if (found.option === 'u') scoped.push(found.rest || next);
  return found.used;
}

/** @brief env 的 名字=值：设值按 setsVar 判断；CDPATH、GIT_DIR / GIT_WORK_TREE 记下；只作用于这条命令。 */
function envAssign(scan: Scan, arg: Arg, value: string, scoped: string[], env: GitEnv): void {
  const name = value.slice(0, value.indexOf('='));
  scan.setsVar(name);
  scoped.push(name);
  if (name === 'CDPATH') scan.cdpath = true;
  if (GIT_NAMES.has(name)) env[name as GitName] = { arg: scan.slice(arg, name.length + 1), shell: 'bash' };
}

/**
 * @brief env：跳过选项（短选项可以组合），然后的 名字=值 同开头的赋值；-i / -u 让四个变量看不出来、PATH 不是只读命令；
 *        -C、-S 与认不出的长选项解析失败；真正的命令交给 inner（没有命令时只打印）。
 * @param inner 去掉 env 与它的选项、赋值之后的命令与这条命令前缀的 git 变量
 */
export function envArgs(scan: Scan, args: Arg[], baseEnv: GitEnv, inner: (rest: Arg[], env: GitEnv) => void): void {
  const scoped: string[] = [];
  const env: GitEnv = { ...baseEnv };
  let k = 1;
  let options = true;
  while (k < args.length) {
    const value = scan.valueOrText(args[k]);
    const next = k + 1 < args.length ? scan.valueOrText(args[k + 1]) : '';
    if (options && value === '--') { options = false; k += 1; } else if (options && value.startsWith('-')) {
      k += envOption(scan, value, next, scoped);
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      envAssign(scan, args[k], value, scoped, env);
      options = false;
      k += 1;
    } else break;
  }
  for (const name of scoped) scan.touchVar(name);
  const undo = scan.scopeVars(scoped);
  inner(args.slice(k), env);
  undo();
}
