// 命令分析（docs/specs/file-system-permissions.md §7.2–§7.9）：纯函数，不读文件、不读环境变量、不看系统，只看参数。
// 读 bash / powershell 工具的 command 文字，给出认出的写入目标（§7.5、§7.6）和换过目录之后还在跑的非只读命令（§7.7）；
// 不判断目标在不在工作路径里、是不是受保护路径（由 pathGate.ts 按真实路径判断，§6.4）。
// 入口、类型和两种 shell 共用的部分（变量的值、路径解析、当前目录的几种可能、循环与 && / || 列表、git、嵌套 shell、
// 结果与去重）在本文件的 Scan 上，bash 的 GNU 选项的分法（写入命令、包装命令与 xargs 的选项表）也在这里；
// Git Bash 的词法、语法与逐条处理在 commandScanBash.ts，PowerShell 的在 commandScanPs.ts，两者只以类型引用本文件。

import { win32 } from 'node:path';
import { scanBashText } from './commandScanBash';
import { scanPsText } from './commandScanPs';
import { samePath } from './pathGate';

// ---- 接口（§7.2） ----

/** @brief commandScan 的输入。 */
export interface ScanInput {
  /** bash / powershell 工具的 command 参数（tool_call 里 pi 校验后的 event.input.command） */
  command: string;
  /** 哪个工具：'bash' 按 Git Bash 的语法，'powershell' 按 PowerShell 的语法 */
  shell: 'bash' | 'powershell';
  /** 会话的工作路径（ctx.cwd，绝对 Windows 路径）；相对路径从这里开始解析 */
  cwd: string;
  /** Mori 知道值的变量：TEMP、TMP、TMPDIR → <cwd>\.work\tmp（workVars(cwd)，与 spawnHook 设的值相同，§7.11） */
  vars: Readonly<Record<string, string>>;
}

/** @brief 目标看不出来的原因（§7.6）。 */
export type UnknownWhy = 'variable' | 'home' | 'glob' | 'substitution' | 'input' | 'shell-path'
  | 'drive-relative' | 'provider' | 'parameter' | 'directory';

/** @brief 一个认出的写入目标。 */
export interface ScanWrite {
  /** 认出它的写法。重定向写操作符原样，含紧挨的 fd 数字（'>'、'>>'、'2>'、'2>>'、'3<>'、'&>'、'&>>'、'>|'、'>&'、'*>'、'*>>'；
   *  bash 的 '{名字}>' 记作 '>'）；命令写 'tee'、'cp'、'mv'、'rm'、'rmdir'、'mkdir'、'touch'、'ln'、'sed -i'、'Set-Content'、
   *  'Add-Content'、'Out-File'、'Tee-Object'、'New-Item'、'Copy-Item'、'Move-Item'、'Remove-Item'、'Rename-Item'
   *  （cmdlet 用全名，不用别名） */
  form: string;
  /** 命令里的原文（去掉引号与转义后）；批准卡的 targets 显示它。命令里没写出的目标写解析时用的那一段：
   *  Copy-Item / Move-Item 没有 Destination 时为 '.'，ln 只有一个操作数时为它的文件名，New-Item 只有 Name 时为 Name，
   *  Rename-Item 的新名字为 NewName；看不出来的补出目标见 §7.6 */
  text: string;
  /** 解析后的绝对路径（path.win32.resolve 规范化）；看不出来时为 null，§6 按写到外面处理 */
  path: string | null;
  /** path 为 null 的原因；看得出来时为 null */
  unknown: UnknownWhy | null;
  /** 删除或移走：rm、rmdir、Remove-Item 的目标，mv / Move-Item 的源，Rename-Item 的原名（§6 据此认“删掉工作路径本身”） */
  remove: boolean;
  /** 从命令文字就看得出东西落在 path 这个目录里面（§7.5“落进目录”）；§6 的按目录放行据此取 path 本身而不是它的上级。
   *  path 为 null 或 remove 为真时为 false */
  into: boolean;
}

/** @brief 换过目录（当前目录不是工作路径本身，或看不出在哪）之后还跑了一条不是只读的命令（§7.7）；在不在工作路径里由 §6 按真实路径判断。 */
export interface ScanLeave {
  /** 换目录的写法：'cd'、'pushd'、'popd'、'Set-Location'、'Push-Location'、'Pop-Location'、'git -C'、'--git-dir'、
   *  '--work-tree'、'GIT_DIR'、'GIT_WORK_TREE' */
  form: string;
  /** 目录的原文（cd 没有参数时为 '~'） */
  text: string;
  /** 解析后的目录（字面，不跟链接）；看不出来时为 null */
  dir: string | null;
  /** 在那里跑的命令：git 写 'git <子命令>'，cmdlet 写全名，其他写去掉路径和 .exe 的名字（例如 'npm'） */
  command: string;
}

/** @brief 分析结果。ok 为假时整条命令按写到外面处理（§7.8）。 */
export type ScanResult =
  | { ok: true; writes: ScanWrite[]; leaves: ScanLeave[] }
  | { ok: false; reason: string };

/** @brief scanCommand 的结果加上只读的判断（§7.7 末尾“只读命令”，只读会话用，§8.11）。 */
export interface ScanVerdict {
  /** scanCommand 的结果（同一次分析） */
  result: ScanResult;
  /** 只读命令：ok 为真、没有认出的写入，跑的每条简单命令都在只读名单里（§7.7 末尾） */
  readOnly: boolean;
}

/** @brief 命令文字的上限：超过时解析失败（§7.8，临时默认值）。 */
export const SCAN_MAX_CHARS = 1_000_000;
/** @brief 括号、替换、嵌套 shell、eval 合计的嵌套层数上限：超过时解析失败（§7.8，临时默认值）。 */
export const SCAN_MAX_DEPTH = 32;
/**
 * @brief 写入目标与 leave 合计的上限：超过时按 the command is too long 解析失败。路径闸只解析前 100 个目标（§6.3），
 *        更多的目标同样按写到外面处理，所以结论不变；这样一条命令的结果占用的内存有上限（例如一再 cd x 之后的写入）。
 */
export const SCAN_MAX_RESULTS = 1000;
/** @brief 路径的长度上限（Windows 的 32767 个字符）：更长的路径不存在，按看不出来（directory）处理。 */
export const MAX_PATH_CHARS = 32767;
/** @brief pushd / Push-Location 的栈的深度上限：超过时按 the command is too long 解析失败。 */
export const SCAN_MAX_STACK = 1000;
/**
 * @brief 一次分析里解析出的路径与 leave 的目录、原文合计的字符数上限：超过时按 the command is too long 解析失败。
 *        每条命令处理路径的时间与当前目录的长度成正比，先 cd 到很长的目录再跑十几万条短命令时总量是乘积；
 *        这个上限让分析时间有上限。工作路径一百多个字符、1 MB 的命令里十几万个目标仍在上限以内。
 */
export const SCAN_MAX_PATH_WORK = 64_000_000;
/**
 * @brief 同时可能的当前目录最多几个（|| 两边、if 与 case 的各支、循环，§7.7）：更多时合成一个看不出来的当前目录（偏严，
 *        临时默认值）。每条简单命令按每个可能各处理一遍，这个上限让分析时间最多是只有一个可能时的这么多倍。
 */
export const SCAN_MAX_STATES = 8;

/**
 * @brief 只读名单（§7.7）：只用于 leave，不影响 §7.5 的写法。带条件的在代码里另判：bash 的 find、sort、tree、uniq、
 *        只打印的 env 与 command -v / -V；git 的 branch、remote、stash list、config。PowerShell 一侧是 cmdlet 全名与
 *        外部程序名（别名在 commandScanPs.ts 换成全名后再查）。命令名不分大小写比较；git 子命令照 git 区分大小写。
 */
export const READ_ONLY_COMMANDS: Readonly<Record<'bash' | 'powershell' | 'git', readonly string[]>> = {
  bash: [
    'ls', 'dir', 'vdir', 'cat', 'tac', 'head', 'tail', 'less', 'more', 'wc', 'nl', 'od', 'hexdump', 'strings', 'grep',
    'egrep', 'fgrep', 'rg', 'ag', 'file', 'stat', 'du', 'df', 'pwd', 'echo', 'printf', 'true', 'false', 'test', '[',
    ':', 'which', 'type', 'whereis', 'hash', 'basename', 'dirname', 'realpath', 'readlink', 'date', 'printenv',
    'whoami', 'id', 'hostname', 'uname', 'cut', 'tr', 'column', 'paste', 'join', 'comm', 'diff', 'cmp', 'md5sum',
    'sha1sum', 'sha256sum', 'cksum', 'jq', 'seq', 'sleep', 'dirs', 'export', 'local', 'declare', 'readonly',
    'typeset', 'set', 'unset', 'shift', 'read', 'wait', 'return', 'exit',
  ],
  powershell: [
    'Get-ChildItem', 'Get-Content', 'Get-Item', 'Get-ItemProperty', 'Get-Location', 'Test-Path', 'Resolve-Path',
    'Split-Path', 'Join-Path', 'Select-String', 'Measure-Object', 'Get-FileHash', 'Compare-Object', 'Select-Object',
    'Where-Object', 'ForEach-Object', 'Sort-Object', 'Group-Object', 'Format-Table', 'Format-List', 'Format-Wide',
    'Out-String', 'Out-Host', 'Out-Null', 'Write-Output', 'Write-Host', 'Write-Error', 'Write-Warning',
    'Write-Verbose', 'Get-Command', 'Get-Help', 'Get-Date', 'Get-Process', 'Get-Service', 'Get-Variable',
    'Get-Alias', 'ConvertFrom-Json', 'ConvertTo-Json', 'Start-Sleep', 'where', 'findstr', 'rg', 'whoami', 'hostname',
  ],
  git: [
    'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'blame', 'grep', 'describe',
    'shortlog', 'merge-base', 'name-rev', 'rev-list', 'for-each-ref', 'show-ref', 'version', 'help',
  ],
};

// ---- 两种 shell 共用的类型（commandScanBash.ts、commandScanPs.ts 以类型引用） ----

/** @brief 解析失败的原因（§7.8 表的英文原文，接在 “Couldn’t analyze this command: ” 后面）。 */
export type FailReason = 'unclosed quote' | 'unclosed bracket' | 'unclosed command substitution'
  | 'the command name comes from a variable or substitution' | 'the command text comes from a variable or input'
  | 'encoded command' | `unsupported option ${string}` | 'PowerShell has no < redirection' | 'stop-parsing token'
  | 'cmd.exe metacharacter in an argument' | 'nested too deeply' | 'the command is too long';

/** @brief 哪种 shell 的语法。 */
export type Shell = ScanInput['shell'];

/** @brief 求值后一个词里的一段。 */
export interface Piece {
  /** 原文（去掉引号与转义；变量与替换保留原样） */
  text: string;
  /** 值；看不出来时为 null */
  value: string | null;
  /** value 为 null 的原因 */
  why: UnknownWhy | null;
  /** 在引号里或经过转义：bash 的通配符与开头的 ~ 只认引号外的 */
  quoted: boolean;
  /** 命令里写出的字面字符（不是变量或替换展开出来的） */
  literal: boolean;
}

/** @brief 求值后的一个词（命令名、参数、重定向目标）。 */
export interface Arg {
  pieces: Piece[];
  /** 整个词是 bash 的 <(…) / >(…)：不是文件目标 */
  proc?: boolean;
}

/** @brief 当前目录。 */
export interface Cwd {
  /** 当前目录（字面，不跟链接）；看不出来时为 null */
  dir: string | null;
  /** 最后一次改它的写法（ScanLeave.form）；没改过时为 null，这时 dir 就是工作路径 */
  form: string | null;
  /** 那次写的目录原文（ScanLeave.text） */
  text: string;
  /**
   * dir、form、text 与它都相同、先算出的那一个 Cwd（Scan.moveTo 给出）；没有时为 undefined，代表就是它自己。
   * 只用来少做重复的工作（换目录不再解析、leave 不再拼键），不影响结果
   */
  same?: Cwd;
}

/** @brief pushd / Push-Location 的栈：不可变的链表，保存与恢复状态时不必复制。 */
export interface CwdStack {
  top: Cwd;
  rest: CwdStack | null;
  /** 栈里的项数（含 top） */
  depth: number;
}

/** @brief 一个可能的执行状态：当前目录与 pushd / Push-Location 的栈（§7.7）。 */
export interface State {
  cwd: Cwd;
  stack: CwdStack | null;
}

/** @brief 一段文字执行时的状态：当前目录、pushd 的栈（空时为 null）、PowerShell 里这条命令定义过的函数（小写）。 */
export interface Run {
  cwd: Cwd;
  stack: CwdStack | null;
  /**
   * 同时可能的其他状态（|| 两边、if 与 case 的各支、循环跑几轮之后换到不同的目录，§7.7）；只有一个可能时为空。
   * 简单命令按每一个可能各处理一遍（Scan.eachState）。只整个换掉，不就地修改（空的可以共用）；与 cwd / stack 合起来总是已去重的
   */
  alts: readonly State[];
  functions: Set<string>;
}

/** @brief 一个目标解析的结果：path 为 null 时 why 是原因。 */
export interface Target {
  path: string | null;
  why: UnknownWhy | null;
}

/** @brief git 认的两个环境变量（§7.7）。 */
export type GitName = 'GIT_DIR' | 'GIT_WORK_TREE';

/** @brief GIT_DIR / GIT_WORK_TREE 的值：在 git 调用时按写它的那种 shell 的规则、相对 git 的目录解析。 */
export interface GitVar {
  arg: Arg;
  shell: Shell;
}

/** @brief 一条命令前缀里的 GIT_DIR= / GIT_WORK_TREE=（只作用于这一条命令）。 */
export type GitEnv = Partial<Record<GitName, GitVar>>;

/** @brief 一条 GNU 命令的参数：操作数与按出现顺序的选项（flag 的 value 为 null）。 */
export interface Gnu {
  operands: Arg[];
  options: { key: string; value: Arg | null }[];
}

/**
 * @brief GNU 选项的分法（§7.5）：short 带值的短选项；attached 值只能紧挨的短选项；long 带值的长选项（--x=v 或 --x v）。
 *        “只用 =”的长选项与不认识的选项一样：--x=v 取 v，--x 不带值，所以不另列。
 */
interface GnuSpec {
  short: string;
  attached: string;
  long: ReadonlySet<string>;
}

/** @brief 包装命令的选项（§7.4）：takes 带值的短选项字母；long 认得的长选项全名；valued 其中带值的。 */
interface WrapperSpec {
  takes: string;
  long: ReadonlySet<string>;
  valued: ReadonlySet<string>;
}

/** @brief 生成一个 GnuSpec。 */
function gnuSpec(short: string, attached: string, long: string[]): GnuSpec {
  return { short, attached, long: new Set(long) };
}

/** @brief 生成一个 WrapperSpec。 */
function wrapperSpec(takes: string, long: string[], valued: string[]): WrapperSpec {
  return { takes, long: new Set(long), valued: new Set(valued) };
}

/**
 * @brief bash 认得出的写入命令的选项（照 GNU coreutils 8.32，§7.5）。只用 = 的长选项：tee 的 --output-error；cp 的
 *        --backup、--reflink、--preserve、--context；mv 的 --backup、--context；rm 的 --interactive、--preserve-root；
 *        mkdir 的 --context；ln 的 --backup；sed 的 --in-place；uniq 的 --all-repeated、--group。
 */
const GNU_WRITERS: Readonly<Record<string, GnuSpec>> = {
  tee: gnuSpec('', '', []),
  cp: gnuSpec('tS', '', ['target-directory', 'suffix', 'sparse', 'no-preserve']),
  mv: gnuSpec('tS', '', ['target-directory', 'suffix']),
  rm: gnuSpec('', '', []),
  rmdir: gnuSpec('', '', []),
  mkdir: gnuSpec('m', '', ['mode']),
  touch: gnuSpec('drt', '', ['date', 'reference', 'time']),
  ln: gnuSpec('tS', '', ['target-directory', 'suffix']),
  sed: gnuSpec('efl', 'i', ['expression', 'file', 'line-length']),
  uniq: gnuSpec('fsw', '', ['skip-fields', 'skip-chars', 'check-chars']),
};

/**
 * @brief bash 的 exec、GNU coreutils 8.32 的 nice、timeout、env 的选项（§7.4）：带值的短选项字母、认得的长选项全名与
 *        其中带值的。env 的 C、S 带值（遇到就解析失败）；--chdir、--split-string 不在长选项里（同样解析失败）。
 */
const WRAPPERS: Readonly<Record<string, WrapperSpec>> = {
  exec: wrapperSpec('a', [], []),
  nice: wrapperSpec('n', ['adjustment', 'help', 'version'], ['adjustment']),
  timeout: wrapperSpec('sk', [
    'preserve-status', 'foreground', 'kill-after', 'signal', 'verbose', 'help', 'version',
  ], ['kill-after', 'signal']),
  env: wrapperSpec('uCS', [
    'ignore-environment', 'null', 'unset', 'debug', 'help', 'version', 'block-signal', 'default-signal',
    'ignore-signal', 'list-signal-handling',
  ], ['unset']),
};

/** @brief xargs 带值的长选项（--replace、--eof、--max-lines 只用 =）。 */
const XARGS_LONG: ReadonlySet<string> = new Set([
  'arg-file', 'delimiter', 'max-args', 'max-procs', 'max-chars', 'process-slot-var',
]);

/** @brief 嵌套 shell 读标准输入时读到的：none 没有，file 从文件读（跑脚本），text 正文已知，unknown 来自管道或有展开。 */
export interface Stdin {
  kind: 'none' | 'file' | 'text' | 'unknown';
  text: string;
}

/** @brief 嵌套 shell 的一次调用：当时的当前目录、所在的嵌套层数、标准输入与这条命令前缀的 git 变量。 */
export interface ShellCall {
  cwd: Cwd;
  level: number;
  stdin: Stdin;
  /** 这条命令前缀里的 GIT_DIR= / GIT_WORK_TREE=：嵌套文字里的 git 同样看到（§7.4、§7.7） */
  env: GitEnv;
}

// ---- 常量 ----

/** @brief 以反斜杠结尾的目录只有根（盘符的根、UNC 的共享根），都不长：更长的目录不必看末尾（看末尾会把拼出来的长字符串摊平）。 */
const ROOT_CHARS = 260;
/**
 * @brief 当前目录下的一个名字（不以 ~ 开头，没有分隔符、冒号与通配符）：PowerShell 一侧直接按相对路径解析，
 *        不必逐条看 ~、提供程序路径与通配符（结果与逐条看相同）。
 */
const PLAIN_NAME = /^[^~\\/:*?[][^\\/:*?[]*$/;
/** @brief 一次分析最多记住多少个命令名的比较写法。 */
const KEY_CACHE = 1000;
/** @brief leave() 最多记住多少个当前目录下已记过的命令（几个可能轮流处理时不必每次拼 leave 的键）。 */
const LEFT_CACHE = 64;
/** @brief Scan.moveTo 最多记住多少个换目录的结果（每个留着一个目录，所以要有上限；满了清空重记）。 */
const MOVE_CACHE = 64;
/** @brief Scan.moveTo 记下结果的目录原文：没有 ~、通配符与花括号，换到哪里只由原文、写法与当前目录决定。 */
const PLAIN_DIR = /^[^~*?[{]*$/;
/** @brief 完整的 UNC 根（\\server\share）：win32.resolve 只看它自己；不完整的（//x、\\srv）会去读进程的当前目录。 */
const UNC_ROOT = /^[\\/]{2}[^\\/]+[\\/]+[^\\/]/;
/** @brief 命令改过之后看不出来的四个变量（§7.4、§7.6）。 */
const WORK_NAMES: ReadonlySet<string> = new Set(['TEMP', 'TMP', 'TMPDIR', 'PWD']);
/** @brief PowerShell 里认得出值的变量（小写，不带 $）。 */
const PS_KNOWN: Readonly<Record<string, string>> = {
  'env:temp': 'TEMP', 'env:tmp': 'TMP', 'env:tmpdir': 'TMPDIR', pwd: 'PWD',
};
/** @brief 不是写入目标的设备路径（§7.5，/dev/fd/<n> 另判）。 */
const DEVICES: ReadonlySet<string> = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin', '/dev/tty']);
/** @brief git 的两个环境变量，按这个顺序报告。 */
const GIT_NAMES: readonly GitName[] = ['GIT_DIR', 'GIT_WORK_TREE'];
/** @brief git 带值的全局选项（-C、--git-dir、--work-tree 另外处理）。 */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-c', '--namespace', '--config-env']);
/** @brief 只读的 git 子命令（带 --output 时不算）。 */
const GIT_READ_ONLY: ReadonlySet<string> = new Set(READ_ONLY_COMMANDS.git);
/** @brief git branch 只读时可以带的选项。 */
const GIT_BRANCH_LIST: ReadonlySet<string> = new Set([
  '-a', '-r', '-v', '-vv', '-l', '--list', '--all', '--remotes', '--show-current',
]);
/** @brief git config 只读时带的选项之一。 */
const GIT_CONFIG_READ: ReadonlySet<string> = new Set(['--get', '--get-all', '--list', '-l', '--show-origin']);
/** @brief bash 的只读名单。 */
const BASH_READ_ONLY: ReadonlySet<string> = new Set(READ_ONLY_COMMANDS.bash);
/** @brief PowerShell 的只读名单（小写）。 */
const PS_READ_ONLY: ReadonlySet<string> = new Set(READ_ONLY_COMMANDS.powershell.map((name) => name.toLowerCase()));
/** @brief pwsh / powershell 的开关（小写全名）。 */
const PS_SWITCHES: ReadonlySet<string> = new Set([
  'noprofile', 'noninteractive', 'nologo', 'noexit', 'interactive', 'login', 'mta', 'sta', 'help',
]);
/** @brief pwsh / powershell 带值的选项（小写全名）。 */
const PS_VALUES: ReadonlySet<string> = new Set([
  'executionpolicy', 'windowstyle', 'outputformat', 'inputformat', 'version', 'configurationname', 'settingsfile',
  'custompipename', 'psconsolefile',
]);
/** @brief pwsh / powershell 选项的全名：开关、带值的与另外处理的四个。 */
const PS_OPTIONS: readonly string[] = [
  ...PS_SWITCHES, ...PS_VALUES, 'command', 'file', 'encodedcommand', 'workingdirectory',
];
/** @brief pwsh / powershell 文档列出的选项简写（先于唯一前缀匹配）。 */
const PS_OPTION_ALIASES: Readonly<Record<string, string>> = {
  c: 'command', f: 'file', e: 'encodedcommand', ec: 'encodedcommand', enc: 'encodedcommand', wd: 'workingdirectory',
  ep: 'executionpolicy', ex: 'executionpolicy', nop: 'noprofile', noni: 'noninteractive', nol: 'nologo',
  noe: 'noexit', w: 'windowstyle', v: 'version', i: 'interactive', l: 'login', o: 'outputformat',
  of: 'outputformat', inp: 'inputformat', if: 'inputformat', '?': 'help', h: 'help',
};

/** @brief 分析失败：沿调用栈抛到 scanCommand，变成 ok: false。 */
class ScanFailure extends Error {
  constructor(readonly reason: FailReason) {
    super(reason);
  }
}

/** @brief git 一次调用的目录与子命令（§7.7）。 */
interface GitCall {
  /** 子命令；没有时为 null */
  sub: string | null;
  /** 子命令之后的参数 */
  rest: Arg[];
  /** 带 -C 时换过之后的目录（form 'git -C'，text 为最后一个 -C 的原文）；没有 -C 时为 null */
  moved: Cwd | null;
  /** --git-dir、--work-tree 的值，按出现顺序 */
  options: { form: string; arg: Arg }[];
  /**
   * 子命令之前第一个看不出来的词的原文（git $OPTS …：它可能是子命令，也可能是 -C 目录这类选项）；有它时这次调用不算只读，
   * 另记一条目录看不出来的 git -C leave；没有时为 null
   */
  hidden: string | null;
}

// ---- 共用的小函数 ----

/** @brief Windows 路径换成 Git Bash 里的写法（C:\w → /c/w，\\srv\s → //srv/s）：bash 里的 $TEMP、$PWD 是这种写法（§7.11）。 */
function posixForm(path: string): string {
  const drive = /^([A-Za-z]):[\\/]*/.exec(path);
  const rest = path.slice(drive ? drive[0].length : 0).replace(/\\/g, '/');
  if (!drive) return rest;
  const letter = drive[1].toLowerCase();
  return rest === '' ? `/${letter}` : `/${letter}/${rest}`;
}

/** @brief 一个词里引号外的字面字符；其余（引号里的、变量与替换）各换成一个 \u0001。 */
function unquotedPattern(arg: Arg): string {
  let pattern = '';
  for (const piece of arg.pieces) pattern += piece.literal && !piece.quoted ? piece.text : '\u0001';
  return pattern;
}

/**
 * @brief 文字里有 bash 的花括号展开（{a,b}、{1..3}）：一个 { 之后、下一个 { 或 } 之前有 , 或 ..，并以 } 结束。
 *        逐字符扫一遍（不用会回溯的正则：没有 } 的长词也是线性时间）。
 */
function braceIn(pattern: string): boolean {
  let open = false;
  let found = false;
  for (let k = 0; k < pattern.length; k += 1) {
    const c = pattern[k];
    if (c === '{') {
      open = true;
      found = false;
    } else if (c === '}') {
      if (open && found) return true;
      open = false;
    } else if (open && (c === ',' || (c === '.' && pattern[k - 1] === '.'))) found = true;
  }
  return false;
}

/** @brief 一个词里有 bash 的花括号展开，只看引号外的字面字符。 */
function hasBrace(arg: Arg): boolean {
  if (!arg.pieces.some((piece) => piece.literal && !piece.quoted && piece.text.includes('{'))) return false;
  return braceIn(unquotedPattern(arg));
}

/** @brief 两个可能对结果一样：栈是同一个，目录相同（都看不出来时 form 与原文也相同）。 */
function sameState(a: State, b: State): boolean {
  if (a.stack !== b.stack) return false;
  const x = a.cwd;
  const y = b.cwd;
  return x === y || (x.dir === y.dir && (x.dir !== null || (x.form === y.form && x.text === y.text)));
}

/** @brief states 里有与 state 对结果一样的可能（sameState）。 */
function hasState(states: readonly State[], state: State): boolean {
  for (const old of states) {
    if (sameState(old, state)) return true;
  }
  return false;
}

/**
 * @brief Scan.union 的计算：把 b 并进 kept（kept 已去重，就地加入）；多于 SCAN_MAX_STATES 个时为合成的一个看不出来的
 *        当前目录（偏严，b 里剩下的不再看）。
 */
function mergeStates(kept: State[], b: readonly State[]): State[] {
  for (const state of b) {
    const next = addState(kept, state);
    if (next !== kept) return next;
  }
  return kept;
}

/** @brief 把一个可能并进 kept（就地）；kept 已有 SCAN_MAX_STATES 个、它又不同时为新的数组（合成的一个看不出来的当前目录）。 */
function addState(kept: State[], state: State): State[] {
  if (hasState(kept, state)) return kept;
  if (kept.length >= SCAN_MAX_STATES) return [unknownState([...kept, state])];
  kept.push(state);
  return kept;
}

/** @brief 没有其他可能时的 Run.alts（共用）。 */
const NO_STATES: readonly State[] = [];

/** @brief 把 run 设成这些可能（已去重、不多于 SCAN_MAX_STATES 个、至少一个）。 */
function assignStates(run: Run, kept: readonly State[]): void {
  run.cwd = kept[0].cwd;
  run.stack = kept[0].stack;
  run.alts = kept.length === 1 ? NO_STATES : kept.slice(1);
}

/**
 * @brief 合成的看不出来的当前目录：form 与原文取最后一个换过目录的可能（都没换过、只有栈不同时为 popd）；
 *        栈也看不出来（为空：之后的 popd 看不出回到哪里）。
 */
function unknownState(states: readonly State[]): State {
  let changed: Cwd | null = null;
  for (const state of states) {
    if (state.cwd.form !== null) changed = state.cwd;
  }
  return { cwd: { dir: null, form: changed?.form ?? 'popd', text: changed?.text ?? 'popd' }, stack: null };
}

/** @brief 什么都不撤销（没有要临时改的变量时）。 */
function noUndo(): void {
  return undefined;
}

/**
 * @brief git 的这次调用是不是只读（§7.7 的 git 子命令名单）。
 * @param sub 子命令；没有时为 null
 * @param rest 子命令之后的参数（值，看不出来时为原文）
 */
function gitReadOnly(sub: string | null, rest: readonly string[]): boolean {
  if (sub === null) return true;
  if (GIT_READ_ONLY.has(sub)) return !rest.some((value) => value === '--output' || value.startsWith('--output='));
  if (sub === 'branch') return rest.every((value) => GIT_BRANCH_LIST.has(value));
  if (sub === 'remote') return rest.length === 0 || (rest.length === 1 && rest[0] === '-v');
  if (sub === 'stash') return rest[0] === 'list';
  if (sub === 'config') return rest.some((value) => GIT_CONFIG_READ.has(value));
  return false;
}

/**
 * @brief pwsh / powershell 的一个选项（§7.4）：不分大小写，可以用 -、-- 或 /，先认文档的简写，再认全名与唯一前缀。
 *        / 之后不全是字母的（/c/x/a.ps1）是路径，按位置参数。
 * @param value 参数的值
 * @return 选项的全名；不是选项（位置参数）时为 null；认不出或有歧义时为 ''
 */
function psOption(value: string): string | null {
  const match = /^(?:--|-|\/)([A-Za-z?]+)$/.exec(value);
  if (!match) return value.length > 1 && value.startsWith('-') ? '' : null;
  const name = match[1].toLowerCase();
  if (Object.hasOwn(PS_OPTION_ALIASES, name)) return PS_OPTION_ALIASES[name];
  if (PS_OPTIONS.includes(name)) return name;
  const found = PS_OPTIONS.filter((option) => option.startsWith(name));
  return found.length === 1 ? found[0] : '';
}

// ---- 分析的状态与共用的处理 ----

/** @brief 一次 scanCommand 的状态：结果、去重、命令改过的变量与两种 shell 共用的处理。 */
export class Scan {
  /** 认出的写入目标，按出现顺序 */
  readonly writes: ScanWrite[] = [];
  /** 换过目录之后的非只读命令，按出现顺序 */
  readonly leaves: ScanLeave[] = [];
  /** 命令里设过 CDPATH（§7.4）：之后 bash 的 cd / pushd 对不以 / \ . ~ 盘符开头的操作数看不出目录；unset 不恢复 */
  cdpath = false;
  /**
   * 到目前为止跑的每条简单命令都是只读的（§7.7 末尾“只读命令”）：leave()、非只读的 git 与 notReadOnly() 清掉它；
   * 当前目录没换过时 bash 的 command() 也为它调 leave()
   */
  onlyReads = true;
  /** 之前 export、只有赋值或 $env: 设过的 GIT_DIR、GIT_WORK_TREE（§7.7）；unset 清掉 */
  readonly gitEnv = new Map<GitName, GitVar>();
  /** commandKey 记下的结果（命令名的值 → 比较用的写法），最多 KEY_CACHE 个 */
  private readonly keys = new Map<string, string>();
  /** commandLabel 记下的结果（命令名的值 → ScanLeave.command），最多 KEY_CACHE 个 */
  private readonly labels = new Map<string, string>();
  /** 去重用：路径 → 这个路径上已记的写入 */
  private readonly byPath = new Map<string, ScanWrite[]>();
  /** 去重用：看不出来的写入（parameter 除外）的 form、text、remove */
  private readonly unknownKeys = new Set<string>();
  /** 去重用：leave 的 form、text、dir、command */
  private readonly leaveKeys = new Set<string>();
  /**
   * leave 时的当前目录 → 在那里已记过的命令（只有一个时为它本身）：同一个目录下一再跑的命令不必每次拼 leave 的键
   * （最多 LEFT_CACHE 个目录）
   */
  private readonly left = new Map<Cwd, string | Set<string>>();
  /** 同上，按 Cwd.same（内容相同的当前目录共用一个）：left 里没有、这里有的不必再拼键查重（最多 LEFT_CACHE 个目录） */
  private readonly leftSame = new Map<Cwd, Set<string>>();
  /** moveTo 记下的结果：当前目录（按 Cwd.same）→ 目录原文 → 换到的目录（同样是共用的那一个），合计最多 MOVE_CACHE 个 */
  private readonly moves = new Map<Cwd, Map<string, Cwd>>();
  /** moves 里的结果个数 */
  private moveCount = 0;
  /** eachState 正在按几个可能逐个处理（里面又有几个可能时合成一个看不出来的，遍数不层层相乘） */
  private forking = false;
  /** Scan.loop：正在走的循环层数、是否在最外层循环再走的那一遍、里面的循环是否换过目录 */
  private loops = 0;
  private rerunning = false;
  private dirty = false;
  /** 解析出的路径与 leave 的目录、原文合计的字符数（SCAN_MAX_PATH_WORK） */
  private pathWork = 0;
  /** 从此看不出来的变量（export、只有赋值、read、for、$env: 赋值） */
  private readonly marked = new Set<string>();
  /** 只在当前这条简单命令里看不出来的变量（开头的赋值、env -i / -u），按层计数 */
  private readonly scoped = new Map<string, number>();

  /**
   * @param root 工作路径（P）
   * @param vars ScanInput.vars
   */
  constructor(readonly root: string, private readonly vars: Readonly<Record<string, string>>) {}

  /** @brief 分析失败：整条命令 ok: false。 */
  fail(reason: FailReason): never {
    throw new ScanFailure(reason);
  }

  /**
   * @brief 进入下一层嵌套（括号、替换、嵌套 shell、eval）；超过 SCAN_MAX_DEPTH 时失败。
   * @return 新的层数
   */
  deeper(level: number): number {
    if (level + 1 > SCAN_MAX_DEPTH) this.fail('nested too deeply');
    return level + 1;
  }

  /**
   * @brief 分析一段嵌套 shell 的文字（bash -c、pwsh -c、trap、读标准输入，§7.4）：起点是当时的当前目录，
   *        里面的换目录不影响外面；写入与 leave 合进外面的结果；前缀的 GIT_DIR= / GIT_WORK_TREE= 里面同样看到。
   * @param call 当时的当前目录、调用它的命令所在的层数与前缀的 git 变量
   */
  nested(shell: Shell, text: string, call: ShellCall): void {
    const run: Run = { cwd: call.cwd, stack: null, alts: [], functions: new Set() };
    const level = this.deeper(call.level);
    this.withGitEnv(call.env, () => {
      if (shell === 'bash') scanBashText(this, text, run, level);
      else scanPsText(this, text, run, level);
    });
  }

  /**
   * @brief 在 body 分析的文字里，这条命令前缀的 GIT_DIR= / GIT_WORK_TREE= 当作已设（嵌套 shell、eval、trap 继承，§7.7）。
   *        之后恢复原来的值；里面另设过的值保留（偏严），里面 unset 掉的照样恢复（子 shell 的 unset 不影响外面，偏严）。
   * @param env 前缀里的值
   * @param body 分析嵌套文字
   */
  withGitEnv(env: GitEnv, body: () => void): void {
    const before = GIT_NAMES.map((name) => this.gitEnv.get(name));
    for (const name of GIT_NAMES) {
      const value = env[name];
      if (value) this.gitEnv.set(name, value);
    }
    body();
    GIT_NAMES.forEach((name, k) => {
      const now = this.gitEnv.get(name);
      if (now !== undefined && now !== env[name] && now !== before[k]) return;
      const old = before[k];
      if (old) this.gitEnv.set(name, old);
      else this.gitEnv.delete(name);
    });
  }

  // ---- 当前目录的几种可能（§7.7） ----

  /** @brief run 的全部可能状态，第一个是 run.cwd / run.stack。 */
  statesOf(run: Run): State[] {
    const first: State = { cwd: run.cwd, stack: run.stack };
    return run.alts.length === 0 ? [first] : [first, ...run.alts];
  }

  /** @brief 把 run 设成这些可能（去重；多于 SCAN_MAX_STATES 个时合成一个看不出来的当前目录）。 */
  setStates(run: Run, states: readonly State[]): void {
    if (states.length === 0) return;
    assignStates(run, states.length === 1 ? states : this.union([], states));
  }

  /** @brief 两组可能的并（a 已去重）；多于 SCAN_MAX_STATES 个时合成一个看不出来的当前目录（偏严）。 */
  union(a: readonly State[], b: readonly State[]): State[] {
    return mergeStates(a.slice(), b);
  }

  /**
   * @brief 按每一个可能的状态各处理一遍 body（bash 的一条简单命令、PowerShell 管道的一节），结束时取各遍之后的并。
   *        正在这样逐个处理时（命令替换、嵌套 shell 的文字里）又遇到几个可能，合成一个看不出来的当前目录处理一遍（偏严），
   *        处理的遍数不会层层相乘。各遍都没有改状态时（不换目录的命令）结果就是原来的可能，不必再求并。
   */
  eachState(run: Run, body: () => void): void {
    if (run.alts.length === 0) {
      body();
      return;
    }
    const alts = run.alts;
    const states = this.statesOf(run);
    if (this.forking) {
      this.setStates(run, [unknownState(states)]);
      body();
      return;
    }
    this.forking = true;
    // 前面各遍都没改状态时为 null：它们之后的可能就是它们自己
    let out: State[] | null = null;
    for (let k = 0; k < states.length; k += 1) {
      const state = states[k];
      run.cwd = state.cwd;
      run.stack = state.stack;
      run.alts = NO_STATES;
      body();
      if (out === null && run.alts.length === 0 && run.cwd === state.cwd && run.stack === state.stack) continue;
      const kept: State[] = out ?? mergeStates([], states.slice(0, k));
      const next = addState(kept, { cwd: run.cwd, stack: run.stack });
      out = next === kept ? mergeStates(kept, run.alts) : next;
    }
    this.forking = false;
    if (out !== null) assignStates(run, out);
    else {
      run.cwd = states[0].cwd;
      run.stack = states[0].stack;
      run.alts = alts;
    }
  }

  /**
   * @brief 不改状态、只在换过目录时记 leave 的命令：按每一个可能的当前目录各记一次。同 eachState 逐个处理（含正在逐个
   *        处理时合成一个看不出来的当前目录），各遍都不改状态，所以不必逐个换 run。
   * @param label ScanLeave.command；只读的命令为 null，什么都不记
   */
  eachLeave(run: Run, label: string | null): void {
    if (run.alts.length > 0 && this.forking) this.setStates(run, [unknownState(this.statesOf(run))]);
    if (label === null) return;
    this.leave(run.cwd, label);
    for (const state of run.alts) this.leave(state.cwd, label);
  }

  /**
   * @brief 一个循环（§7.7）：会重复的部分（条件与主体）先从进入时的状态走一遍。走完换到了别的目录（或里面的循环换过）时，
   *        之后的每一轮都从别处开始：最外层的循环再从看不出来的当前目录走一遍，代表之后的每一轮；嵌着的循环不自己再走，
   *        交给最外层，在最外层再走的那一遍里从看不出来的当前目录开始。每段文字最多走两遍。
   *        结束时的状态是进入时（一轮都不跑）与各遍走完时的并。
   * @param body 走一遍会重复的部分（PowerShell 先把读的位置放回开头）
   */
  loop(run: Run, body: () => void): void {
    const entry = this.statesOf(run);
    if (this.rerunning) {
      this.setStates(run, [unknownState(entry)]);
      body();
      this.setStates(run, this.union(entry, this.statesOf(run)));
      return;
    }
    const dirty = this.dirty;
    this.dirty = false;
    this.loops += 1;
    body();
    this.loops -= 1;
    const first = this.statesOf(run);
    const changed = this.dirty || first.some((state) => !entry.some((old) => sameState(old, state)));
    this.dirty = dirty || (changed && this.loops > 0);
    const after = this.union(entry, first);
    if (!changed) this.setStates(run, after);
    else if (this.loops > 0) this.setStates(run, this.union(after, [unknownState(first)]));
    else {
      this.rerunning = true;
      this.setStates(run, [unknownState(after)]);
      body();
      this.rerunning = false;
      this.setStates(run, this.union(after, this.statesOf(run)));
    }
  }

  /**
   * @brief cd、pushd、Set-Location、Push-Location 换到的目录（§7.7）。目录的词只有一段字面字符、没有 ~、通配符与花括号时，
   *        结果只由当前目录、写法与原文决定：同一个当前目录（按 Cwd.same）下第一次照常算，之后给出内容相同的新 Cwd
   *        （same 指向第一次的结果；与当前目录内容相同时指向当前目录的那一个），处理路径的字符数照算。
   *        每次仍给新的 Cwd，leave() 按对象记过的命令与每次都算时相同；一再 cd .. 时几个可能的当前目录总是同几个 same，
   *        leave() 不必每次拼键，也不必每次解析路径。
   * @param operand 目录的词
   * @param from 当前目录
   * @param form 写法（Cwd.form）
   * @param make 照常算出换到的目录（form 为这个写法，text 为这个词的原文）
   */
  moveTo(operand: Arg, from: Cwd, form: string, make: () => Cwd): Cwd {
    const piece = operand.pieces.length === 1 ? operand.pieces[0] : null;
    if (!piece || !piece.literal || piece.value !== piece.text) return make();
    const base = from.same ?? from;
    // 记下的原文都合 PLAIN_DIR，查到时不必再看
    const known = this.moves.get(base)?.get(piece.text);
    if (known && known.form === form && known.text === piece.text) {
      if (known.dir !== null) this.charge(known.dir.length);
      return { dir: known.dir, form, text: known.text, same: known };
    }
    if (!PLAIN_DIR.test(piece.text)) return make();
    const cwd = make();
    const same = cwd.dir === base.dir && cwd.form === base.form && cwd.text === base.text ? base : cwd;
    if (same !== cwd) cwd.same = same;
    if (this.moveCount >= MOVE_CACHE) {
      this.moves.clear();
      this.moveCount = 0;
    }
    let byText = this.moves.get(base);
    if (!byText) {
      byText = new Map();
      this.moves.set(base, byText);
    }
    byText.set(piece.text, same);
    this.moveCount += 1;
    return cwd;
  }

  /** @brief 开始一个用 && / || 连起来的列表；start 为第一个管道之前的可能（默认为现在的）。 */
  chain(run: Run, start: State[] = this.statesOf(run)): Chain {
    return new Chain(this, run, start);
  }

  // ---- 变量（§7.4、§7.6） ----

  /** @brief 这个名字（TEMP、TMP、TMPDIR、PWD，大写）此刻看不出来：命令改过它。 */
  private changed(name: string): boolean {
    return this.marked.has(name) || (this.scoped.get(name) ?? 0) > 0;
  }

  /** @brief 从此看不出来（export、只有赋值、read、for、$env: 赋值）；name 已按 shell 的规则换成大写，其他名字不管。 */
  markVar(name: string): void {
    if (WORK_NAMES.has(name)) this.marked.add(name);
  }

  /**
   * @brief 只在一条简单命令里看不出来（开头的赋值、env -i / -u），含它经包装与嵌套 shell 分析的文字。
   * @param names 名字（大写），其他名字不管
   * @return 命令结束时调用，撤销这一层
   */
  scopeVars(names: readonly string[]): () => void {
    const added = names.filter((name) => WORK_NAMES.has(name));
    if (added.length === 0) return noUndo;
    for (const name of added) this.scoped.set(name, (this.scoped.get(name) ?? 0) + 1);
    return () => {
      for (const name of added) this.scoped.set(name, (this.scoped.get(name) ?? 1) - 1);
    };
  }

  /**
   * @brief 一个变量引用的值（§7.6）：TEMP、TMP、TMPDIR 取 vars，PWD 取当前目录；命令改过的、其他变量都看不出来。
   * @param name 变量名：bash 区分大小写（'TMPDIR'）；PowerShell 带作用域（'env:TEMP'、'pwd'），不分大小写
   * @param raw 命令里的原文（'$TMPDIR'、'${env:TEMP}'）
   * @param shell 哪种 shell：bash 的值是 Git Bash 的写法（/c/…）
   * @param cwd 当前目录
   * @param quoted 在引号里
   */
  varPiece(name: string, raw: string, shell: Shell, cwd: Cwd, quoted: boolean): Piece {
    const lower = name.toLowerCase();
    const psKey = Object.hasOwn(PS_KNOWN, lower) ? PS_KNOWN[lower] : null;
    const key = shell === 'bash' ? (WORK_NAMES.has(name) ? name : null) : psKey;
    const unknown = (why: UnknownWhy): Piece => ({ text: raw, value: null, why, quoted, literal: false });
    if (key === null || this.changed(key)) return unknown('variable');
    const value = key === 'PWD' ? cwd.dir : (this.vars[key] ?? null);
    if (value === null) return unknown(key === 'PWD' ? 'directory' : 'variable');
    if (shell !== 'bash') return { text: raw, value, why: null, quoted, literal: false };
    this.charge(value.length);
    return { text: raw, value: posixForm(value), why: null, quoted, literal: false };
  }

  // ---- 词（Arg） ----

  /** @brief 原文（去掉引号与转义；变量与替换保留原样）。 */
  text(arg: Arg): string {
    const pieces = arg.pieces;
    if (pieces.length === 1) return pieces[0].text;
    let text = '';
    for (const piece of pieces) text += piece.text;
    return text;
  }

  /** @brief 值；有看不出来的部分时为 null（通配符与 ~ 不在这里判断）。 */
  valueOf(arg: Arg): string | null {
    if (arg.pieces.length === 1) return arg.pieces[0].value;
    let value = '';
    for (const piece of arg.pieces) {
      if (piece.value === null) return null;
      value += piece.value;
    }
    return value;
  }

  /** @brief 值；看不出来时为原文（比较选项与子命令用）。 */
  valueOrText(arg: Arg): string {
    return this.valueOf(arg) ?? this.text(arg);
  }

  /** @brief 词的开头是写出来的字面字符时为它的原文（认选项用），否则为 null（例如 "$X"）。 */
  optionText(arg: Arg): string | null {
    return arg.pieces[0]?.literal ? this.text(arg) : null;
  }

  /**
   * @brief 词从原文的第 from 个字符起的部分（--x=v 的值、-tDIR 的 DIR）；切点落在变量或替换里时整段保留。
   */
  slice(arg: Arg, from: number): Arg {
    const pieces: Piece[] = [];
    let at = 0;
    for (const piece of arg.pieces) {
      const end = at + piece.text.length;
      if (end > from) {
        const cut = Math.max(0, from - at);
        if (cut === 0 || !piece.literal) pieces.push(piece);
        else pieces.push({ ...piece, text: piece.text.slice(cut), value: (piece.value ?? '').slice(cut) });
      }
      at = end;
    }
    return { pieces };
  }

  /** @brief 一个字面的词（补出来的 echo、PowerShell 传给外部程序的参数名）。 */
  lit(text: string): Arg {
    return { pieces: [{ text, value: text, why: null, quoted: true, literal: true }] };
  }

  /** @brief 一个看不出来的词。 */
  unknown(text: string, why: UnknownWhy): Arg {
    return { pieces: [{ text, value: null, why, quoted: true, literal: false }] };
  }

  /** @brief xargs 的输入、find -exec 的 {}、PowerShell 从管道绑定的目标（§7.6）。 */
  input(): Arg {
    return this.unknown('(paths from input)', 'input');
  }

  /** @brief 命令名比较用的写法：去掉路径和 .exe，小写（§7.4）。 */
  commandKey(name: Arg): string {
    const value = this.valueOrText(name);
    let key = this.keys.get(value);
    if (key === undefined) {
      key = this.commandLabel(name).toLowerCase();
      if (this.keys.size < KEY_CACHE) this.keys.set(value, key);
    }
    return key;
  }

  /** @brief ScanLeave.command 用的名字：去掉路径和 .exe（同 commandKey 记下结果）。 */
  commandLabel(name: Arg): string {
    const value = this.valueOrText(name);
    let label = this.labels.get(value);
    if (label === undefined) {
      const base = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1);
      label = base.length > 4 && base.slice(-4).toLowerCase() === '.exe' ? base.slice(0, -4) : base;
      if (this.labels.size < KEY_CACHE) this.labels.set(value, label);
    }
    return label;
  }

  /**
   * @brief bash 的命令名有引号外的通配符（* ?、后面有 ] 的 [）或花括号展开（§7.4、§7.6）：展开之后才知道跑的是什么。
   *        单独的 [ 是 test 命令，不算。
   */
  globName(name: Arg): boolean {
    const pattern = unquotedPattern(name);
    if (pattern.includes('*') || pattern.includes('?')) return true;
    const open = pattern.indexOf('[');
    return (open >= 0 && pattern.indexOf(']', open + 1) > 0) || braceIn(pattern);
  }

  /** @brief 目标从文字看得出落在目录里面（§7.5“落进目录”）：以 / 或 \ 结尾，或最后一段是 . 或 ..。 */
  intoDir(arg: Arg): boolean {
    return /(?:[\\/]|(?:^|[\\/])\.\.?)$/.test(this.valueOrText(arg));
  }

  /** @brief 只读名单（§7.7）：bash 用 commandKey，PowerShell 用小写的 cmdlet 全名或外部程序名。 */
  readOnly(shell: Shell, key: string): boolean {
    return shell === 'bash' ? BASH_READ_ONLY.has(key) : PS_READ_ONLY.has(key);
  }

  // ---- GNU 选项（§7.4、§7.5；bash 的写入命令、包装命令与 xargs 用） ----

  /** @brief bash 认得出的写入命令（与 uniq）按 GNU 的规则分好的参数（args 不含命令名）；不是这些命令时为 null。 */
  gnuOf(key: string, args: Arg[]): Gnu | null {
    return Object.hasOwn(GNU_WRITERS, key) ? this.gnu(args, GNU_WRITERS[key]) : null;
  }

  /** @brief bash 认得出的写入命令（GNU_WRITERS 里除 uniq 以外的）。 */
  isWriter(key: string): boolean {
    return key !== 'uniq' && Object.hasOwn(GNU_WRITERS, key);
  }

  /** @brief 按 GNU 的规则分出选项与操作数（§7.5）：短选项可以组合；-- 之后都是操作数；不认识的选项当作不带值。 */
  private gnu(args: Arg[], spec: GnuSpec): Gnu {
    const out: Gnu = { operands: [], options: [] };
    for (let k = 0; k < args.length; k += 1) {
      const text = this.optionText(args[k]);
      if (text === '--') {
        out.operands.push(...args.slice(k + 1));
        break;
      }
      if (text === null || !text.startsWith('-') || text === '-') out.operands.push(args[k]);
      else if (text.startsWith('--')) k += this.gnuLong(args[k], text, args[k + 1], spec, out);
      else k += this.gnuShort(args[k], text, args[k + 1], spec, out);
    }
    return out;
  }

  /** @brief 一个长选项；返回多用掉的参数个数。 */
  private gnuLong(arg: Arg, text: string, next: Arg | undefined, spec: GnuSpec, out: Gnu): number {
    const eq = text.indexOf('=');
    if (eq >= 0) {
      out.options.push({ key: text.slice(2, eq), value: this.slice(arg, eq + 1) });
      return 0;
    }
    const key = text.slice(2);
    const takes = spec.long.has(key) && next !== undefined;
    out.options.push({ key, value: takes ? next : null });
    return takes ? 1 : 0;
  }

  /** @brief 一组短选项；组合里遇到带值的字母，剩下的部分是它的值，没剩下时取下一个词。 */
  private gnuShort(arg: Arg, text: string, next: Arg | undefined, spec: GnuSpec, out: Gnu): number {
    for (let p = 1; p < text.length; p += 1) {
      const key = text[p];
      if (spec.attached.includes(key)) {
        out.options.push({ key, value: this.slice(arg, p + 1) });
        return 0;
      }
      if (!spec.short.includes(key)) {
        out.options.push({ key, value: null });
        continue;
      }
      if (p + 1 < text.length) out.options.push({ key, value: this.slice(arg, p + 1) });
      else out.options.push({ key, value: next ?? null });
      return p + 1 < text.length || next === undefined ? 0 : 1;
    }
    return 0;
  }

  /**
   * @brief 包装命令（exec、nice、timeout）的选项在哪里结束（§7.4）：短选项按 GNU 的规则组合（-vs KILL、-la sh），
   *        长选项只认全名，-- 结束选项。
   * @param args 含命令名的参数
   * @param key 命令名（WRAPPERS 的键）
   * @return 第一个不是选项的词的位置
   */
  wrapperStart(args: Arg[], key: string): number {
    let k = 1;
    while (k < args.length) {
      const value = this.valueOrText(args[k]);
      if (value === '--') return k + 1;
      if (value.startsWith('--')) k += this.longOption(value, key);
      else if (/^-./.test(value)) k += this.cluster(value, WRAPPERS[key].takes).used;
      else return k;
    }
    return k;
  }

  /**
   * @brief 包装命令（key 为 WRAPPERS 的键）的一个长选项：认得的全名里带值的取 =v 或下一个词。认不出的（含缩写 --chd、
   *        --adj）解析失败：GNU 认唯一前缀，按缩写猜会漏掉 env --chdir 这类。
   * @return 用掉几个词
   */
  longOption(value: string, key: string): number {
    const spec = WRAPPERS[key];
    const eq = value.indexOf('=');
    const name = value.slice(2, eq < 0 ? undefined : eq);
    if (!spec.long.has(name)) this.fail(`unsupported option --${name}`);
    return eq < 0 && spec.valued.has(name) ? 2 : 1;
  }

  /**
   * @brief xargs 的一个选项（§7.4）。
   * @param value 选项原文
   * @param next 下一个参数的原文
   * @return used：用掉几个参数；replace：替换串（-I、-i、--replace）
   */
  xargsOption(value: string, next: string | null): { used: number; replace: string | null } {
    if (value.startsWith('--')) {
      const eq = value.indexOf('=');
      const name = value.slice(2, eq < 0 ? undefined : eq);
      if (name === 'replace') return { used: 1, replace: eq < 0 ? '{}' : value.slice(eq + 1) };
      return { used: eq < 0 && XARGS_LONG.has(name) ? 2 : 1, replace: null };
    }
    for (let p = 1; p < value.length; p += 1) {
      const c = value[p];
      const rest = value.slice(p + 1);
      if (c === 'I') return rest ? { used: 1, replace: rest } : { used: 2, replace: next };
      if (c === 'i') return { used: 1, replace: rest || '{}' };
      if (c === 'e' || c === 'l') return { used: 1, replace: null };
      if ('adELnPs'.includes(c)) return { used: rest ? 1 : 2, replace: null };
    }
    return { used: 1, replace: null };
  }

  /**
   * @brief 包装命令的一组短选项（§7.5 的 GNU 规则：可以组合；带值的字母取组合剩下的部分，没剩下时取下一个词）。
   * @param value 这一组的原文（以 - 开头）
   * @param takes 带值的字母
   * @return flags：带值字母之前的字母；option：带值的字母（没有时为 ''）；rest：组合里剩下的部分；used：用掉几个词
   */
  cluster(value: string, takes: string): { flags: string; option: string; rest: string; used: number } {
    for (let p = 1; p < value.length; p += 1) {
      if (!takes.includes(value[p])) continue;
      const rest = value.slice(p + 1);
      return { flags: value.slice(1, p), option: value[p], rest, used: rest ? 1 : 2 };
    }
    return { flags: value.slice(1), option: '', rest: '', used: 1 };
  }

  // ---- 路径解析（§7.6） ----

  /**
   * @brief 解析一个目标。
   * @param arg 目标的词
   * @param cwd 当前目录
   * @param shell 按哪种 shell 的规则
   * @param literal PowerShell 的 LiteralPath：不认通配符
   * @return 目标；不是文件目标（/dev/null、<(…)、空字符串）时为 null
   */
  resolve(arg: Arg, cwd: Cwd, shell: Shell, literal: boolean): Target | null {
    if (arg.proc) return null;
    const result = shell === 'bash' ? this.bashValue(arg) : { value: this.valueOf(arg), why: this.firstWhy(arg) };
    if (result.value === null) return { path: null, why: result.why ?? 'variable' };
    if (result.value === '') return null;
    const target = shell === 'bash' ? this.bashPath(result.value, cwd) : this.psPath(result.value, cwd, literal);
    if (target === null || target.path === null) return target;
    if (target.path.length > MAX_PATH_CHARS) return { path: null, why: 'directory' };
    this.charge(target.path.length);
    return target;
  }

  /** @brief 第一个看不出来的部分的原因。 */
  private firstWhy(arg: Arg): UnknownWhy | null {
    return arg.pieces.find((piece) => piece.why !== null)?.why ?? null;
  }

  /** @brief bash 的值：引号外开头的 ~、变量与替换、引号外的通配符与花括号展开都看不出来。 */
  private bashValue(arg: Arg): { value: string | null; why: UnknownWhy | null } {
    const first = arg.pieces[0];
    if (first && first.literal && !first.quoted && first.text.startsWith('~')) return { value: null, why: 'home' };
    for (const piece of arg.pieces) {
      if (piece.why !== null) return { value: null, why: piece.why };
      if (piece.literal && !piece.quoted && /[*?[]/.test(piece.text)) return { value: null, why: 'glob' };
    }
    if (hasBrace(arg)) return { value: null, why: 'glob' };
    return { value: this.valueOf(arg), why: null };
  }

  /**
   * @brief Git Bash 的路径：设备不是目标；完整的 UNC；不完整的（//x、//）同以 \ 开头，在当前目录所在盘的根下；
   *        /c/… 换成 C:\…，其他 /… 是 msys 根下的路径；其余同 Windows。
   */
  private bashPath(value: string, cwd: Cwd): Target | null {
    const first = value[0];
    if (first !== '/' && first !== '\\') return this.windowsPath(value, cwd);
    if (DEVICES.has(value) || /^\/dev\/fd\/\d+$/.test(value)) return null;
    if (UNC_ROOT.test(value)) return { path: win32.resolve(value), why: null };
    if (first === '\\' || value[1] === '/' || value[1] === '\\') return this.windowsPath(value, cwd);
    const match = value.includes('\\') ? null : /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(value);
    if (!match) return { path: null, why: 'shell-path' };
    return { path: win32.resolve(`${match[1].toUpperCase()}:\\${match[2] ?? ''}`), why: null };
  }

  /**
   * @brief PowerShell 的路径：~、提供程序路径（FileSystem:: 去掉前缀后照常）、LiteralPath 以外的通配符、完整的 UNC；
   *        其余同 Windows（不完整的 UNC \\srv 在当前目录所在盘的根下）。
   */
  private psPath(value: string, cwd: Cwd, literal: boolean): Target {
    if (PLAIN_NAME.test(value)) return this.windowsPath(value, cwd);
    if (/^~(?:[\\/]|$)/.test(value)) return { path: null, why: 'home' };
    const plain = value.replace(/^(?:Microsoft\.PowerShell\.Core\\)?FileSystem::/i, '');
    if (/^[^\\/:]*::/.test(plain) || /^[^\\/:]{2,}:/.test(plain)) return { path: null, why: 'provider' };
    if (!literal && /[*?[]/.test(plain)) return { path: null, why: 'glob' };
    if (UNC_ROOT.test(plain)) return { path: win32.resolve(plain), why: null };
    return this.windowsPath(plain, cwd);
  }

  /** @brief 盘符绝对、盘符相对（看不出来）、以 \ 或 / 开头（当前目录所在盘的根下）、相对路径（当前目录 + 它）。 */
  private windowsPath(value: string, cwd: Cwd): Target {
    if (value[1] === ':' && /^[A-Za-z]/.test(value)) {
      if (/^[A-Za-z]:[\\/]/.test(value)) return { path: win32.resolve(value), why: null };
      return { path: null, why: 'drive-relative' };
    }
    if (cwd.dir === null) return { path: null, why: 'directory' };
    if (/^[^\\/:]+$/.test(value) && value !== '.' && value !== '..') {
      const root = cwd.dir.length <= ROOT_CHARS && cwd.dir.endsWith('\\');
      return { path: root ? cwd.dir + value : `${cwd.dir}\\${value}`, why: null };
    }
    return { path: win32.resolve(cwd.dir, value), why: null };
  }

  // ---- 结果 ----

  /**
   * @brief 记一个写入目标；form、text、path、remove 都相同的只留第一个（§7.2）。看不出来的参数（parameter）不去重：
   *        每条这样的命令各出一个目标（§7.9 的 S20）。
   * @param form ScanWrite.form
   * @param text ScanWrite.text
   * @param target 解析的结果
   * @param remove 删除或移走
   * @param into 从文字看得出落进目录
   */
  write(form: string, text: string, target: Target, remove: boolean, into: boolean): void {
    const path = target.path;
    const same = path === null ? undefined : this.byPath.get(path);
    if (same?.some((old) => old.form === form && old.text === text && old.remove === remove)) return;
    const unknownKey = path === null && target.why !== 'parameter' ? `${form}\u0000${text}\u0000${remove}` : null;
    if (unknownKey !== null && this.unknownKeys.has(unknownKey)) return;
    const write: ScanWrite = {
      form, text, path, unknown: path === null ? target.why : null, remove, into: path !== null && !remove && into,
    };
    this.count();
    if (same) same.push(write);
    else if (path !== null) this.byPath.set(path, [write]);
    if (unknownKey !== null) this.unknownKeys.add(unknownKey);
    this.writes.push(write);
  }

  /**
   * @brief pushd / Push-Location：把当前目录压栈（`cwd` 为压栈时的当前目录）；栈超过 SCAN_MAX_STACK 项时按
   *        the command is too long 失败（栈里的每一项都留着一个目录，深度要有上限）。
   */
  push(stack: CwdStack | null, cwd: Cwd): CwdStack {
    const depth = (stack?.depth ?? 0) + 1;
    if (depth > SCAN_MAX_STACK) this.fail('the command is too long');
    return { top: cwd, rest: stack, depth };
  }

  /** @brief 再记一条结果之前：已有 SCAN_MAX_RESULTS 条时失败（结果的个数与长度都有上限）。 */
  private count(): void {
    if (this.writes.length + this.leaves.length >= SCAN_MAX_RESULTS) this.fail('the command is too long');
  }

  /**
   * @brief 记下命令里有不产生 leave、却不是只读的部分（§7.7 末尾第 4 条：PowerShell 的方法调用与按成员名的
   *        ForEach-Object）。
   */
  notReadOnly(): void {
    this.onlyReads = false;
  }

  /** @brief 记下处理路径的字符数（拼出、比较与查找一个路径的时间与它的长度成正比）；合计超过 SCAN_MAX_PATH_WORK 时失败。 */
  private charge(chars: number): void {
    this.pathWork += chars;
    if (this.pathWork > SCAN_MAX_PATH_WORK) this.fail('the command is too long');
  }

  /**
   * @brief 一条不是只读的命令：当前目录换过（不是工作路径本身，或看不出来）时，记一条在那里跑 command 的 leave；
   *        不论换没换过，这条命令都不是只读命令（onlyReads）。
   */
  leave(cwd: Cwd, command: string): void {
    this.onlyReads = false;
    if (cwd.form === null) return;
    const seen = this.left.get(cwd);
    if (seen === command || (typeof seen === 'object' && seen.has(command))) return;
    if (seen === undefined) {
      if (this.left.size >= LEFT_CACHE) this.left.clear();
      this.left.set(cwd, command);
    } else if (typeof seen === 'string') this.left.set(cwd, new Set([seen, command]));
    else seen.add(command);
    this.leaveSame(cwd, cwd.form, command);
  }

  /**
   * @brief leave() 里这个对象下没记过的命令：同 leaveAt。内容相同的当前目录（Cwd.same）下 leaveAt 已经处理过它时，
   *        leaveAt 只会记下处理路径的字符数（键已有，或目录就是工作路径），这里照样只记字符数，不再拼键。
   */
  private leaveSame(cwd: Cwd, form: string, command: string): void {
    const same = cwd.same ?? cwd;
    let done = this.leftSame.get(same);
    if (done?.has(command)) {
      this.charge(cwd.text.length + (cwd.dir?.length ?? 0) + command.length);
      return;
    }
    this.leaveAt(form, cwd.text, cwd.dir, command);
    if (!done) {
      if (this.leftSame.size >= LEFT_CACHE) this.leftSame.clear();
      done = new Set();
      this.leftSame.set(same, done);
    }
    done.add(command);
  }

  /**
   * @brief 目录不是工作路径本身（或看不出来）时记一条 leave；form、text、dir、command 都相同的只留第一个。
   *        dir 也比：同一段原文在不同的当前目录下换到不同的地方（cd src; …; cd ../..; cd src），后一条不能丢。
   */
  leaveAt(form: string, text: string, dir: string | null, command: string): void {
    this.charge(text.length + (dir?.length ?? 0) + command.length);
    const key = `${form}\u0000${text}\u0000${dir ?? ''}\u0000${command}`;
    if (this.leaveKeys.has(key) || (dir !== null && samePath(dir, this.root))) return;
    this.count();
    this.leaveKeys.add(key);
    this.leaves.push({ form, text, dir, command });
  }

  // ---- git（§7.7） ----

  /**
   * @brief 一次 git 调用：git 自己的写入不算；不是只读时，按 -C 换过的目录（没有 -C 时按 shell 的当前目录）、
   *        --git-dir、--work-tree、GIT_DIR、GIT_WORK_TREE 各记 leave。
   * @param args git 之后的参数
   * @param cwd shell 的当前目录
   * @param shell 按哪种 shell 的规则解析目录
   * @param env 这条命令前缀里的 GIT_DIR= / GIT_WORK_TREE=
   */
  git(args: Arg[], cwd: Cwd, shell: Shell, env: GitEnv): void {
    const call = this.gitCall(args, cwd, shell);
    if (call.hidden === null && gitReadOnly(call.sub, call.rest.map((arg) => this.valueOrText(arg)))) return;
    this.onlyReads = false;
    const command = `git ${call.sub ?? call.hidden}`;
    if (call.hidden !== null) this.leaveAt('git -C', call.hidden, null, command);
    if (call.moved) this.leaveAt('git -C', call.moved.text, call.moved.dir, command);
    else this.leave(cwd, command);
    const base: Cwd = call.moved ?? cwd;
    for (const option of call.options) this.gitDir(option.form, { arg: option.arg, shell }, base, command);
    for (const name of GIT_NAMES) {
      const value = env[name] ?? this.gitEnv.get(name);
      if (value) this.gitDir(name, value, base, command);
    }
  }

  /**
   * @brief 找出 git 的全局选项与子命令；-C 可以几个，后一个相对前一个。子命令之前看不出来的词（git $OPTS -C .. commit）
   *        不当子命令，记在 hidden 里，接着找 -C、--git-dir、--work-tree。
   */
  private gitCall(args: Arg[], cwd: Cwd, shell: Shell): GitCall {
    const call: GitCall = { sub: null, rest: [], moved: null, options: [], hidden: null };
    for (let k = 0; k < args.length; k += 1) {
      const value = this.valueOrText(args[k]);
      const next = args[k + 1];
      if (value === '-C' && next) {
        const target = this.resolve(next, call.moved ?? cwd, shell, true);
        call.moved = { dir: target?.path ?? null, form: 'git -C', text: this.text(next) };
        k += 1;
      } else if ((value === '--git-dir' || value === '--work-tree') && next) {
        call.options.push({ form: value, arg: next });
        k += 1;
      } else if (/^--(?:git-dir|work-tree)=/.test(value)) {
        const eq = value.indexOf('=');
        call.options.push({ form: value.slice(0, eq), arg: this.slice(args[k], eq + 1) });
      } else if (GIT_VALUE_OPTIONS.has(value)) {
        k += 1;
      } else if (this.valueOf(args[k]) === null) call.hidden ??= value;
      else if (!value.startsWith('-')) {
        call.sub = value;
        call.rest = args.slice(k + 1);
        return call;
      }
    }
    return call;
  }

  /** @brief --git-dir、--work-tree、GIT_DIR、GIT_WORK_TREE 的一条 leave：相对 git 的目录解析。 */
  private gitDir(form: string, value: GitVar, base: Cwd, command: string): void {
    const target = this.resolve(value.arg, base, value.shell, true);
    this.leaveAt(form, this.text(value.arg), target?.path ?? null, command);
  }

  // ---- 嵌套 shell（§7.4） ----

  /**
   * @brief bash / sh / pwsh / powershell 的一次调用：-c / -Command 的文字与读到的标准输入按对应 shell 分析。
   * @param key commandKey：'bash'、'sh'、'pwsh' 或 'powershell'
   * @param args 含命令名的参数
   * @param call 当时的当前目录、层数、标准输入与前缀的 git 变量
   * @return 'script'：跑脚本（-File、位置参数、从文件读标准输入），不分析，调用方按普通命令做 leave 检查；'done'：已分析
   */
  shellArgs(key: string, args: Arg[], call: ShellCall): 'script' | 'done' {
    if (key === 'bash' || key === 'sh') return this.bashShell(args, call);
    return this.psShell(args, call, key === 'powershell');
  }

  /**
   * @brief bash [选项] -c 文字 [参数…]；-c 可以在组合里，-o / -O / +o 带值；没有 -c 也没有脚本时读标准输入。
   *        选项的位置上有看不出来的词（bash $FLAGS -c '…'）时，它可能是空的或是选项：之后还有 -c / -s 或标准输入有正文时
   *        看不出要跑的文字，解析失败；否则当作跑脚本。
   */
  private bashShell(args: Arg[], call: ShellCall): 'script' | 'done' {
    let k = 1;
    let command = false;
    let stdin = false;
    for (; k < args.length; k += 1) {
      const value = this.optionText(args[k]);
      if (value === null && !command && this.hiddenBashText(args, k + 1, call)) {
        this.fail('the command text comes from a variable or input');
      }
      if (value === null || !/^[-+]./.test(value)) break;
      if (value === '--') { k += 1; break; }
      if (/^[-+][oO]$/.test(value) || value === '--rcfile' || value === '--init-file') { k += 1; continue; }
      if (/^-[^-]*c/.test(value)) command = true;
      if (/^-[^-]*s/.test(value)) stdin = true;
    }
    if (command) {
      if (k < args.length) this.nested('bash', this.mustText(args[k]), call);
      return 'done';
    }
    if (k < args.length && !stdin) return 'script';
    return this.readStdin('bash', call);
  }

  /** @brief bash 选项位置上看不出来的词之后（from 起）还有 -c / -s 的组合，或标准输入有正文（here-doc、管道）。 */
  private hiddenBashText(args: Arg[], from: number, call: ShellCall): boolean {
    if (call.stdin.kind === 'text' || call.stdin.kind === 'unknown') return true;
    for (let k = from; k < args.length; k += 1) {
      const value = this.optionText(args[k]);
      if (value === null) continue;
      if (/^[-+][oO]$/.test(value) || value === '--rcfile' || value === '--init-file') k += 1;
      else if (/^-[^-]*[cs]/.test(value)) return true;
    }
    return false;
  }

  /**
   * @brief pwsh / powershell 的选项（§7.4）：-Command 的文字、-File 与位置参数、解析失败的选项、读标准输入。
   *        pwsh 的选项位置上有看不出来的词时，见 psHidden。
   */
  private psShell(args: Arg[], call: ShellCall, five: boolean): 'script' | 'done' {
    for (let k = 1; k < args.length; k += 1) {
      const value = this.valueOf(args[k]);
      const option = value === null ? null : psOption(value);
      if (value === null && !five) return this.psHidden(args, k + 1, call);
      if (option === null) return five ? this.psCommand(args.slice(k), call) : 'script';
      if (option === 'command') return this.psCommand(args.slice(k + 1), call);
      if (option === 'file') return 'script';
      if (option === 'encodedcommand') this.fail('encoded command');
      if (option === '' || option === 'workingdirectory') this.fail(`unsupported option ${value}`);
      if (PS_VALUES.has(option)) k += 1;
    }
    return this.readStdin('powershell', call);
  }

  /**
   * @brief pwsh 选项位置上看不出来的词（pwsh $opts -Command …）：它可能是空的或是选项。之后（from 起）还有 -Command、
   *        -EncodedCommand、-WorkingDirectory，或标准输入有正文时按那一条解析失败；否则当作跑脚本。
   */
  private psHidden(args: Arg[], from: number, call: ShellCall): 'script' {
    if (call.stdin.kind === 'text' || call.stdin.kind === 'unknown') {
      this.fail('the command text comes from a variable or input');
    }
    for (let k = from; k < args.length; k += 1) {
      const value = this.valueOf(args[k]);
      const option = value === null ? null : psOption(value);
      if (option === 'command') this.fail('the command text comes from a variable or input');
      if (option === 'encodedcommand') this.fail('encoded command');
      if (option === 'workingdirectory') this.fail(`unsupported option ${value ?? ''}`);
    }
    return 'script';
  }

  /** @brief -Command 之后的参数用空格连起来按 PowerShell 分析；'-' 是读标准输入。 */
  private psCommand(rest: Arg[], call: ShellCall): 'script' | 'done' {
    if (rest.length === 0) return 'done';
    const text = rest.map((arg) => this.mustText(arg)).join(' ');
    if (text === '-') return this.readStdin('powershell', call);
    this.nested('powershell', text, call);
    return 'done';
  }

  /**
   * @brief 嵌套 shell 读标准输入（§7.4）：正文已知时按那种 shell 分析；来自管道或有展开时解析失败；
   *        从文件读（bash < x.sh）是跑脚本，不分析，返回 'script' 让调用方做 leave 检查（同 bash x.sh）。
   */
  private readStdin(shell: Shell, call: ShellCall): 'script' | 'done' {
    if (call.stdin.kind === 'unknown') this.fail('the command text comes from a variable or input');
    if (call.stdin.kind === 'file') return 'script';
    if (call.stdin.kind === 'text') this.nested(shell, call.stdin.text, call);
    return 'done';
  }

  /** @brief 要分析的文字（eval、trap、-c）：有看不出来的部分时解析失败。 */
  mustText(arg: Arg): string {
    const value = this.valueOf(arg);
    if (value === null) this.fail('the command text comes from a variable or input');
    return value;
  }
}

/**
 * @brief 用 && / || 连起来的管道的当前目录（§7.7）：&& 之后的管道从前一段成功时的可能跑，|| 之后的从前面任何一处可能失败时的
 *        可能跑（失败的 cd 留在原处）；整个列表结束时取可能停下的全部可能。只有一个管道时照常（同 `cd ..; x`，按成功算）。
 *        由 Scan.chain 建；每个管道开始时调 next，列表结束时调 end。
 */
export class Chain {
  /** 前面都成功时的可能 */
  private ok: State[] = [];
  /** 可能停下（失败）时的全部可能：第二个管道开始时才算 */
  private all: State[] | null = null;
  /** 已走完的管道个数 */
  private count = 0;
  /** 正在走的管道前面是 || */
  private or = false;
  /** 有一个管道正在走 */
  private open = false;
  /** 上一个管道走完时 run 的可能（close 取的；ok 就是它时 run 不必再设） */
  private last: State[] | null = null;

  constructor(private readonly scan: Scan, private readonly run: Run, private readonly start: State[]) {}

  /** @brief 下一个管道开始（第一个也调用）；or 为它前面是 ||。几组可能都已去重，直接设。 */
  next(or: boolean): void {
    this.close();
    if (this.count > 0) {
      const states = or ? this.failed() : this.ok;
      if (states !== this.last) assignStates(this.run, states);
    }
    this.or = or;
    this.open = true;
  }

  /** @brief 列表结束：有两个以上管道时为可能停下的全部可能。 */
  end(): void {
    this.close();
    if (this.count > 1) assignStates(this.run, this.failed());
  }

  /** @brief 前面任何一处可能失败时的可能：开始时与每个管道走完时的并。 */
  private failed(): State[] {
    this.all ??= this.scan.union(this.start, this.ok);
    return this.all;
  }

  /** @brief 正在走的管道走完了。 */
  private close(): void {
    if (!this.open) return;
    this.open = false;
    const out = this.scan.statesOf(this.run);
    if (this.count > 0) {
      this.all = this.scan.union(this.failed(), out);
      this.ok = this.or ? this.scan.union(this.ok, out) : out;
    } else this.ok = out;
    this.last = out;
    this.count += 1;
  }
}

// ---- 入口 ----

/**
 * @brief 分析一条命令（纯函数：不读文件、不读环境变量、不看系统，只看参数；不接受回调）。
 *        解析失败（§7.8）返回 ok: false；后台进程据此记 [kernel] command not analyzed (<shell>): <reason>（不写命令原文）。
 */
export function scanCommand(input: ScanInput): ScanResult {
  return scanVerdict(input).result;
}

/** @brief 同 scanCommand，另给只读的判断（§7.7 末尾；路径闸用它，一次判断只分析一次）。 */
export function scanVerdict(input: ScanInput): ScanVerdict {
  if (input.command.length > SCAN_MAX_CHARS) {
    return { result: { ok: false, reason: 'the command is too long' }, readOnly: false };
  }
  const root = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(input.cwd) ? win32.resolve(input.cwd) : input.cwd;
  const scan = new Scan(root, input.vars);
  const run: Run = { cwd: { dir: root, form: null, text: '' }, stack: null, alts: [], functions: new Set() };
  try {
    if (input.shell === 'bash') scanBashText(scan, input.command, run, 0);
    else scanPsText(scan, input.command, run, 0);
  } catch (error) {
    if (error instanceof ScanFailure) return { result: { ok: false, reason: error.reason }, readOnly: false };
    throw error;
  }
  const result: ScanResult = { ok: true, writes: scan.writes, leaves: scan.leaves };
  return { result, readOnly: scan.onlyReads && scan.writes.length === 0 };
}
