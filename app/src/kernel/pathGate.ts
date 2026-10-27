// 路径闸的纯函数（docs/specs/file-system-permissions.md §6.2–§6.5、§6.9、§6.13）：照抄 pi 的路径解析（resolveToCwd）与
// “在不在里面”（insideDir）、同一路径的比较、段名比较、受保护名单、调用分类与目标归类、批准请求的 targets 与按目录放行。
// 只有 realTarget 碰文件系统，lstat、realpath 从参数传入（默认 node:fs 的同步版），单元测试据此计数（FS-29）。
// 词法上在工作路径外的目标本身不碰文件系统（网络路径不会让 Windows 去连那台主机；删掉或移走它们时只取工作路径的
// 真实路径来比）；一次分类最多解析 100 个目标，工作路径的真实路径只在要用时取一次；现算、不缓存、不监视。命令的写入目标由 commandScan.ts 分析（§7），这里只用它的结果。
// 判断顺序（§6.1）在 approval.ts，收窄（§8）在 limits.ts，两者共用这里的一次分类。

import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  READ_ONLY_TOOLS, type ApprovalScope, type ApprovalTarget,
} from '../shared/protocol';
import { TEAM_TOOLS } from '../shared/team';
import { ASK_TOOL } from '../shared/workspace';
import { scanCommand, type ScanLeave, type ScanWrite } from './commandScan';
import { MEMORY_TOOL } from './teamHost';
import { WORK_DIR, workVars } from './workspace';

// ---- 词法解析（§6.3，照抄 pi 1.3.0） ----

/** @brief pi utils/paths.js 的 UNICODE_SPACES：不换行空格、U+2000–U+200A、窄不换行空格、数学空格、全角空格。 */
function isUnicodeSpace(code: number): boolean {
  return code === 0xa0 || (code >= 0x2000 && code <= 0x200a) || code === 0x202f || code === 0x205f
    || code === 0x3000;
}

/** @brief pi utils/paths.js normalizeWindowsShellPath：Git Bash、MSYS、Cygwin、WSL 的盘符路径换成 Windows 路径。 */
function windowsShellPath(filePath: string): string {
  if (!filePath.startsWith('/') || filePath.startsWith('//') || filePath.includes('\\')) return filePath;
  const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(filePath);
  if (!match) return filePath;
  const suffix = match[2]?.replaceAll('/', '\\');
  return `${match[1].toUpperCase()}:\\${suffix ?? ''}`;
}

/**
 * @brief pi 1.3.0 utils/paths.js normalizePath（包没有导出，照写）：可选地换掉特殊空格、去掉开头的 @，
 *        win32 上换 /c/… 的写法，展开 ~，file:// 换成路径。
 * @param input 路径
 * @param tool 工具参数的路径（resolveToCwd 的 normalizeUnicodeSpaces 与 stripAtPrefix）；工作目录为假
 */
function normalizePath(input: string, tool: boolean): string {
  let normalized = tool ? [...input].map((char) => (isUnicodeSpace(char.codePointAt(0) ?? 0) ? ' ' : char)).join('')
    : input;
  if (tool && normalized.startsWith('@')) normalized = normalized.slice(1);
  if (process.platform === 'win32') normalized = windowsShellPath(normalized);
  const home = homedir();
  if (normalized === '~') return home;
  if (normalized.startsWith('~/') || (process.platform === 'win32' && normalized.startsWith('~\\'))) {
    return join(home, normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

/**
 * @brief pi 1.3.0 core/tools/path-utils.js resolveToCwd（包没有导出，照写；write、edit 工具按它定位文件）：
 *        规范化后是绝对路径就直接 resolve，否则相对工作目录（工作目录只做 /c/…、~、file:// 三步）。
 * @param filePath 工具参数里的 path
 * @param cwd 会话的工作目录（ctx.cwd）
 */
export function resolveToCwd(filePath: string, cwd: string): string {
  const normalized = normalizePath(filePath, true);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(normalizePath(cwd, false), normalized);
}

/**
 * @brief 路径落在目录里（§6.3，照 pi utils/paths.js getCwdRelativePath）：relative 为空，或既不等于 ..、也不以 ..
 *        加分隔符开头，且不是绝对路径。win32 的 relative 不分大小写、统一 / 与 \，前缀相同的兄弟目录不算在里面，
 *        `..notes` 这种名字算在里面。
 * @param dir 目录（绝对路径）
 * @param target 目标（绝对路径）
 */
export function insideDir(dir: string, target: string): boolean {
  const inside = relative(dir, target);
  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
}

/** @brief 是不是同一个路径（§7.2）：path.win32.relative 为空（不分大小写、统一 / 与 \）。 */
export function samePath(a: string, b: string): boolean {
  return win32.relative(a, b) === '';
}

// ---- 真实路径（§6.3） ----

/** @brief 文件系统探针（默认 node:fs 的 lstatSync / realpathSync.native）；单元测试注入计数的替身。 */
export interface FsProbe {
  /** 看路径本身（不跟链接）；不存在时抛 ENOENT / ENOTDIR */
  lstat(path: string): unknown;
  /** 真实路径（解析符号链接、目录联接、8.3 短名） */
  realpath(path: string): string;
}

/** @brief 后台进程用的探针。 */
export const NODE_FS: FsProbe = Object.freeze({
  lstat: (path: string) => lstatSync(path),
  realpath: (path: string) => realpathSync.native(path),
});

/** @brief 系统错误的 code；不是系统错误时为 undefined。 */
function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/**
 * @brief 目标的真实路径（§6.3 第 2、3 条）：从目标往上找第一个 lstat 能看到的路径（含悬空的链接本身），对它取 realpath，
 *        再接上还不存在的那几段；整条路径都不存在时没有链接，就是目标本身。最多“段数”次 lstat 与一次 realpath。
 * @param target 词法解析后的绝对路径
 * @param fsx 文件系统探针
 * @return 真实路径；realpath 失败或 lstat 报 ENOENT、ENOTDIR 以外的错时为 null（记日志）
 */
export function realTarget(target: string, fsx: FsProbe = NODE_FS): string | null {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      fsx.lstat(current);
      break;
    } catch (error) {
      const code = codeOf(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return cannotResolve(target, error);
    }
    const parent = dirname(current);
    if (parent === current) return target;
    missing.unshift(basename(current));
    current = parent;
  }
  try {
    const real = fsx.realpath(current);
    return missing.length > 0 ? join(real, ...missing) : real;
  } catch (error) {
    return cannotResolve(target, error);
  }
}

/** @brief 真实路径取不到：记日志，按工作路径外处理（§6.3 第 3 条）。 */
function cannotResolve(target: string, error: unknown): null {
  console.error(`[kernel] path gate: cannot resolve ${target}: ${(error as Error).message}`);
  return null;
}

// ---- 名字的比较与受保护名单（§6.3、§6.5） ----

/**
 * @brief 段名比较用的写法（§6.3）：去掉 NTFS 流名（第一个 : 及之后），再去掉末尾的 . 与空格（Windows 打开文件时也这样
 *        去掉），小写。调用方不把绝对路径的盘符或共享根交给它。
 */
export function segmentKey(segment: string): string {
  const colon = segment.indexOf(':');
  const name = colon >= 0 ? segment.slice(0, colon) : segment;
  return name.replace(/[. ]+$/, '').toLowerCase();
}

/** @brief 受保护的目录（§6.5）：任一段等于它；两段的 .config/git 要连续两段依次相等。 */
export const PROTECTED_DIRS: readonly string[] = Object.freeze([
  '.git', '.vscode', '.idea', '.husky', '.cargo', '.devcontainer', '.yarn', '.mvn', '.claude', '.mori', '.pi',
  '.config/git',
]);

/** @brief 受保护的文件（§6.5）：最后一段等于它。 */
export const PROTECTED_FILES: readonly string[] = Object.freeze([
  '.gitconfig', '.gitmodules',
  '.bashrc', '.bash_profile', '.bash_login', '.bash_aliases', '.bash_logout', '.zshrc', '.zprofile', '.zshenv',
  '.zlogin', '.zlogout', '.profile', '.envrc',
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnp.cjs', '.pnp.loader.mjs', '.pnpmfile.cjs', 'bunfig.toml', '.bunfig.toml',
  '.bazelrc', '.bazelversion', '.bazeliskrc',
  '.pre-commit-config.yaml', 'lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml',
  'gradle-wrapper.properties', 'maven-wrapper.properties',
  '.devcontainer.json',
  '.ripgreprc', 'pyrightconfig.json',
  '.mcp.json', '.claude.json',
]);

/** 受保护目录按段拆开（.config/git 为两段） */
const DIR_SEQUENCES: readonly (readonly string[])[] = PROTECTED_DIRS.map((dir) => dir.split('/'));
/** 受保护文件名 */
const FILE_NAMES: ReadonlySet<string> = new Set(PROTECTED_FILES);

/** @brief 相对路径拆成段（空串为没有段）。 */
function segmentsOf(path: string): string[] {
  return path.split(/[\\/]+/).filter((segment) => segment !== '');
}

/** @brief 绝对路径去掉盘符根或共享根之后的段（§6.4：工作路径外的目标按完整路径比名单）。 */
function absoluteSegments(path: string): string[] {
  return segmentsOf(path.slice(parse(path).root.length));
}

/** @brief 这些段命中受保护名单（§6.5）：任一段（或连续两段）是受保护目录，或最后一段是受保护文件。 */
function hitsProtected(segments: readonly string[]): boolean {
  const keys = segments.map(segmentKey);
  for (let i = 0; i < keys.length; i++) {
    if (DIR_SEQUENCES.some((dir) => dir.every((name, k) => keys[i + k] === name))) return true;
  }
  return keys.length > 0 && FILE_NAMES.has(keys[keys.length - 1]);
}

// ---- 调用分类（§6.2） ----

/** @brief 按职责给的工具（§6.2）：TaskBoard 的 11 个工具、memory、ask_user_question；免批准、不收窄。 */
export const DUTY_TOOLS: ReadonlySet<string> = new Set([...TEAM_TOOLS, MEMORY_TOOL, ASK_TOOL]);

/** @brief 调用的种类（§6.2）。 */
export type CallKind = 'duty' | 'read' | 'file' | 'command' | 'other';

/** @brief 参数里的一个字符串字段；没有或不是字符串时为 null。 */
function stringArg(input: unknown, key: string): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/**
 * @brief 调用的种类（§6.2）：只看工具名和 pi 校验过的参数。edit、write 的参数里没有字符串 path，bash、powershell 的
 *        参数里没有字符串 command 时按 other。
 * @param toolName 工具名
 * @param input tool_call 的 event.input（预告时为 tool_execution_start 的 args）
 */
export function callKind(toolName: string, input: unknown): CallKind {
  if (DUTY_TOOLS.has(toolName)) return 'duty';
  if (READ_ONLY_TOOLS.includes(toolName)) return 'read';
  if ((toolName === 'edit' || toolName === 'write') && stringArg(input, 'path') !== null) return 'file';
  if ((toolName === 'bash' || toolName === 'powershell') && stringArg(input, 'command') !== null) return 'command';
  return 'other';
}

// ---- 目标的归类（§6.4） ----

/** @brief 一个目标的归类（§6.4）；看不出的 unresolved、换到外面的 leaves、分析不了的 unanalyzed。 */
export type TargetClass = 'inside' | 'work' | 'protected' | 'outside' | 'unresolved' | 'leaves' | 'unanalyzed';

/** @brief 一个写入目标（或留下的 leave、分析不了的命令）。 */
export interface GateTarget {
  /** 归类 */
  cls: TargetClass;
  /** 批准请求里带的路径（§6.4 最后一条）；unresolved、unanalyzed、看不出目录的 leaves 为 null */
  path: string | null;
  /** 真实路径（inside/work/protected/outside 时有，取不到或词法在外面时为词法路径）；用于 allowDirs 与 checkLimits */
  real: string | null;
  /** 参数里的原文（edit/write 的 path、命令里的那一段、leave 的目录；unanalyzed 为原因；分类出错时为工具名） */
  text: string;
  /** 删除或移走这个路径（只有命令有） */
  remove: boolean;
  /** 从命令文字看得出东西落在 path 这个目录里面（只有命令有，§6.9） */
  into: boolean;
}

/** @brief 一次判断的分类结果（§6.1：第 2–4 步共用）。 */
export interface ClassifiedCall {
  /** 种类 */
  kind: CallKind;
  /** 工具名 */
  toolName: string;
  /** 每个写入目标与留下的 leaves（写入在前、leaves 在后，各按命令里出现的顺序；最多解析 100 个，之后看不出） */
  targets: GateTarget[];
  /** §6.4 的 scope */
  scope: ApprovalScope;
  /** 工作路径的真实路径（§6.3，checkLimits 用）；没有要取真实路径的目标时为词法路径 */
  realCwd: string;
}

/** @brief 一个调用最多解析的目标数（§6.3、§17）。 */
export const MAX_RESOLVED_TARGETS = 100;

/** @brief 一次分类共用的上下文：词法工作路径、探针，以及按需取一次的真实工作路径。 */
interface GateContext {
  /** 词法工作路径（同 pi 对 cwd 的处理） */
  cwd: string;
  /** 这次分类用的文件系统探针（默认 NODE_FS，单元测试注入计数的替身） */
  fsx: FsProbe;
  /** 还没取为 undefined；取不到为 null */
  realCwd: string | null | undefined;
}

/** @brief 工作路径的真实路径，一次分类只取一次（FS-29）。 */
function realCwdOf(context: GateContext): string | null {
  if (context.realCwd === undefined) context.realCwd = realTarget(context.cwd, context.fsx);
  return context.realCwd;
}

/** @brief 一个路径的归类结果（§6.4）。 */
interface PathClass {
  /** 归类 */
  cls: 'inside' | 'work' | 'protected' | 'outside';
  /** 批准请求里带的路径：真实路径；protected 只因词法路径命中名单时为词法路径 */
  path: string;
  /** 真实路径（词法在外面或取不到时为词法路径） */
  real: string;
  /** 词法与真实路径都在工作路径里（或就是工作路径本身）；leave 据此丢掉 */
  within: boolean;
}

/**
 * @brief 工作路径外的目标（§6.4 第 3 行）：完整的绝对路径（词法路径；词法在里面、真实在外面的再加上真实路径）任一段
 *        命中名单时归 protected，带命中名单的那个（真实路径优先）；否则 outside，带真实路径。
 */
function outsidePath(lexical: string, real: string): PathClass {
  if (hitsProtected(absoluteSegments(real))) return { cls: 'protected', path: real, real, within: false };
  if (hitsProtected(absoluteSegments(lexical))) return { cls: 'protected', path: lexical, real, within: false };
  return { cls: 'outside', path: real, real, within: false };
}

/** @brief 词法与真实路径都在工作路径里的目标（§6.4 第 4–6 行）：.work 先于名单，名单比相对工作路径的段。 */
function withinPath(context: GateContext, lexical: string, real: string, realCwd: string): PathClass {
  const realSegments = segmentsOf(relative(realCwd, real));
  if (realSegments.length > 0 && segmentKey(realSegments[0]) === WORK_DIR) {
    return { cls: 'work', path: real, real, within: true };
  }
  if (hitsProtected(realSegments)) return { cls: 'protected', path: real, real, within: true };
  if (hitsProtected(segmentsOf(relative(context.cwd, lexical)))) {
    return { cls: 'protected', path: lexical, real, within: true };
  }
  return { cls: 'inside', path: real, real, within: true };
}

/**
 * @brief 词法上在工作路径外的目标（§6.3 第 1 条）：不碰目标本身，真实路径就是词法路径。删掉或移走时还要和工作路径的
 *        真实路径比（§6.4 第 1 行“真实路径或词法路径”：工作路径经过目录联接、subst 盘符或 8.3 短名打开时，删掉它
 *        真正所在的目录也删掉了工作路径）；只取工作路径的真实路径，一次分类一次。
 */
function lexicalOutside(context: GateContext, lexical: string, remove: boolean): PathClass {
  const realCwd = remove ? realCwdOf(context) : null;
  if (realCwd !== null && insideDir(lexical, realCwd)) {
    return { cls: 'protected', path: lexical, real: lexical, within: false };
  }
  return outsidePath(lexical, lexical);
}

/**
 * @brief 一个路径按 §6.4 的表归类（先满足的为准）：删掉或移走工作路径本身或它的上级（词法路径或真实路径）→
 *        protected；写进工作路径本身 → inside；词法或真实路径在外面、真实路径取不到 → outside（名单命中改为
 *        protected）；其余看 .work 与名单。
 * @param context 这次分类的上下文
 * @param lexical 词法解析后的绝对路径
 * @param remove 删除或移走
 */
function classifyPath(context: GateContext, lexical: string, remove: boolean): PathClass {
  if (remove && insideDir(lexical, context.cwd)) {
    return { cls: 'protected', path: lexical, real: lexical, within: false };
  }
  if (!remove && samePath(lexical, context.cwd)) {
    return { cls: 'inside', path: lexical, real: realCwdOf(context) ?? lexical, within: true };
  }
  if (!insideDir(context.cwd, lexical)) return lexicalOutside(context, lexical, remove);
  const realCwd = realCwdOf(context);
  const real = realCwd === null ? null : realTarget(lexical, context.fsx);
  if (realCwd === null || real === null) return outsidePath(lexical, lexical);
  if (remove && insideDir(real, realCwd)) return { cls: 'protected', path: real, real, within: false };
  if (!insideDir(realCwd, real)) return outsidePath(lexical, real);
  return withinPath(context, lexical, real, realCwd);
}

/** @brief 解析的预算（§6.3：最多 100 个）。 */
interface Budget {
  /** 还能解析的目标数（写入与 leave 共用） */
  left: number;
}

/** @brief 命令的一个写入目标：path 为 null 或超出预算时看不出（unresolved）。 */
function writeTarget(context: GateContext, write: ScanWrite, budget: Budget): GateTarget {
  if (write.path === null || budget.left <= 0) {
    return { cls: 'unresolved', path: null, real: null, text: write.text, remove: write.remove, into: false };
  }
  budget.left--;
  const place = classifyPath(context, write.path, write.remove);
  return { cls: place.cls, path: place.path, real: place.real, text: write.text, remove: write.remove,
    into: write.into };
}

/**
 * @brief 一个 leave（§6.4 倒数第二条）：dir 在工作路径里（词法与真实路径都在）的丢掉；看不出、在外面、超出预算的记作
 *        leaves（看不出目录时 path 为 null）。
 * @return 记下的目标；丢掉时为 null
 */
function leaveTarget(context: GateContext, leave: ScanLeave, budget: Budget): GateTarget | null {
  const unknown: GateTarget = { cls: 'leaves', path: null, real: null, text: leave.text, remove: false, into: false };
  if (leave.dir === null || budget.left <= 0) return unknown;
  budget.left--;
  const place = classifyPath(context, leave.dir, false);
  return place.within ? null : { ...unknown, path: place.real, real: place.real };
}

/** @brief 一个调用的 scope（§6.4 最后一段）。 */
function scopeOf(targets: readonly GateTarget[]): ApprovalScope {
  if (targets.some((target) => target.cls === 'protected')) return 'protected';
  return targets.some((target) => target.cls !== 'inside' && target.cls !== 'work') ? 'outside' : 'inside';
}

/** @brief 命令的目标（§6.2）：分析不了时一个 unanalyzed；否则写入在前、leaves 在后。 */
function commandTargets(context: GateContext, shell: 'bash' | 'powershell', command: string): GateTarget[] {
  const scan = scanCommand({ command, shell, cwd: context.cwd, vars: workVars(context.cwd) });
  if (!scan.ok) return [{ cls: 'unanalyzed', path: null, real: null, text: scan.reason, remove: false, into: false }];
  const budget: Budget = { left: MAX_RESOLVED_TARGETS };
  const writes = scan.writes.map((write) => writeTarget(context, write, budget));
  const leaves = scan.leaves.map((leave) => leaveTarget(context, leave, budget));
  return [...writes, ...leaves.filter((target): target is GateTarget => target !== null)];
}

/** @brief 按种类取目标（§6.2）：file 一个，command 按 commandScan 的结果，其余没有。 */
function targetsOf(context: GateContext, kind: CallKind, toolName: string, input: unknown): GateTarget[] {
  if (kind === 'file') {
    const text = stringArg(input, 'path') ?? '';
    const place = classifyPath(context, resolveToCwd(text, context.cwd), false);
    return [{ cls: place.cls, path: place.path, real: place.real, text, remove: false, into: false }];
  }
  if (kind === 'command') {
    const shell = toolName === 'powershell' ? 'powershell' : 'bash';
    return commandTargets(context, shell, stringArg(input, 'command') ?? '');
  }
  return [];
}

/**
 * @brief 分类一个调用（§6.2–§6.4）：命令调 scanCommand({ command, shell, cwd, vars: workVars(cwd) })。不抛错：
 *        分类或 commandScan 出错时记日志 `[kernel] path gate: <原文>`，按 scope outside、一个 unresolved 目标
 *        （text 为工具名）处理（§6.1）。
 * @param toolName 工具名
 * @param input tool_call 的 event.input（预告时为 args）
 * @param cwd 工作路径（ctx.cwd；预告时为 GateOutput.cwd）
 * @param fsx 文件系统探针（单元测试注入）
 */
export function classifyCall(toolName: string, input: unknown, cwd: string, fsx: FsProbe = NODE_FS): ClassifiedCall {
  const kind = callKind(toolName, input);
  const context: GateContext = { cwd: resolve(normalizePath(cwd, false)), fsx, realCwd: undefined };
  try {
    const targets = targetsOf(context, kind, toolName, input);
    return { kind, toolName, targets, scope: scopeOf(targets), realCwd: context.realCwd ?? context.cwd };
  } catch (error) {
    console.error(`[kernel] path gate: ${(error as Error).message}`);
    const target: GateTarget = { cls: 'unresolved', path: null, real: null, text: toolName, remove: false,
      into: false };
    return { kind, toolName, targets: [target], scope: 'outside', realCwd: context.realCwd ?? context.cwd };
  }
}

// ---- 批准请求（§6.9、§6.13） ----

/** @brief 批准请求的 targets（§6.13）：要问的原因，按顺序；scope inside 时为空。 */
export function approvalTargets(call: ClassifiedCall): ApprovalTarget[] {
  if (call.scope === 'inside') return [];
  const asked: ApprovalTarget[] = [];
  for (const target of call.targets) {
    if (target.cls === 'inside' || target.cls === 'work') continue;
    asked.push({ reason: target.cls, path: target.path, text: target.text });
  }
  return asked;
}

/** @brief 一个 outside 目标的落点目录（§6.9）：into 时是目标本身，否则是它的上一级；都取真实路径。 */
function landingDir(target: GateTarget): string {
  const real = target.real ?? '';
  return target.into ? real : dirname(real);
}

/** @brief 盘符根或共享根（D:\、\\主机\共享\）。 */
function isRoot(dir: string): boolean {
  const full = resolve(dir);
  return parse(full).root === full;
}

/** @brief 要问的目标（§6.13）：去掉 inside 与 work 的写入，它们没有理由。 */
function askedOf(call: ClassifiedCall): GateTarget[] {
  return call.targets.filter((target) => target.cls !== 'inside' && target.cls !== 'work');
}

/**
 * @brief 能不能按目录放行（§6.9）：scope outside，每个要问的目标的理由都是 outside 且有真实路径；
 *        同一调用里 inside、.work 的写入不影响这个选项。
 */
function dirAllowable(call: ClassifiedCall): boolean {
  const asked = askedOf(call);
  return call.scope === 'outside' && asked.length > 0
    && asked.every((target) => target.cls === 'outside' && target.real !== null);
}

/**
 * @brief Allow writes to <目录> for this session 会放行的目录（§6.9）：每个要问的目标的落点目录，去掉重复
 *        （不分大小写），按目标出现的顺序；没有这个选项（有别的理由、要放行的是盘符根或共享根）时为空。
 */
export function allowDirsOf(call: ClassifiedCall): string[] {
  if (!dirAllowable(call)) return [];
  const dirs: string[] = [];
  for (const target of askedOf(call)) {
    const dir = landingDir(target);
    if (isRoot(dir)) return [];
    if (!dirs.some((known) => samePath(known, dir))) dirs.push(dir);
  }
  return dirs;
}

/**
 * @brief 要问的目标都被按目录放行覆盖（§6.9）：scope outside，每个要问的目标都是 outside，且落点目录与某个
 *        放行的目录 relative 为空（只覆盖直接放在目录里的目标，不含子目录）；inside、.work 的写入不算在内。
 * @param call 这次的分类
 * @param dirs ApprovalPolicy 记下的目录
 */
export function coveredByDirs(call: ClassifiedCall, dirs: readonly string[]): boolean {
  if (dirs.length === 0 || !dirAllowable(call)) return false;
  return askedOf(call).every((target) => {
    const dir = landingDir(target);
    return dirs.some((allowed) => samePath(allowed, dir));
  });
}
