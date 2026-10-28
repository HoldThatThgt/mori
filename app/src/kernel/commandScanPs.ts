// PowerShell 的命令分析（docs/specs/file-system-permissions.md §7.3–§7.7）：边读边处理。PowerShell 的位置属于整个运行空间，
// 括号与脚本块都不隔开（§7.3“作用域”），所以不另建语法树：语句、管道、命令（参数绑定与认得出的 cmdlet）与表达式。
// 只被 commandScan.ts 调用，只以类型引用它；变量的值、路径解析、当前目录的几种可能、git、嵌套 shell 与结果都在 Scan 上。

import { win32 } from 'node:path';
import type { Arg, Chain, Cwd, CwdStack, FailReason, Piece, Run, Scan, State, Target } from './commandScan';

// ---- 类型 ----

/** @brief 命令的一个参数。param：-名字（-名字:值 时 value 为值）；value：值（逗号数组的每一项；end 为 --）；splat：@名字。 */
type PsArg =
  | { k: 'param'; name: string; value: Arg[] | null }
  | { k: 'value'; items: Arg[]; end: boolean }
  | { k: 'splat'; raw: string };

/** @brief cmdlet 参数的用途：path / literal 是目标（Path、LiteralPath），dest 是 Destination，name、newname、variable 另算，
 *        value 是其余带值的，switch 是开关。 */
type Role = 'path' | 'literal' | 'dest' | 'name' | 'newname' | 'variable' | 'value' | 'switch';

/** @brief cmdlet 的一个参数（§7.5，5.1 与 7 的并集）。group 相同的只能绑一个（Path 与 LiteralPath）。 */
interface Param {
  name: string;
  /** 小写的全名与别名（匹配用） */
  lower: string;
  aliases: readonly string[];
  /** 位置参数的位置；不是位置参数时为 null */
  pos: number | null;
  role: Role;
  group: string | null;
}

/** @brief 一个 cmdlet 的参数表：全部参数、按位置排好的位置参数、目标参数（Path、LiteralPath 这一组）。 */
interface Spec {
  params: readonly Param[];
  slots: readonly Param[];
  targets: readonly Param[];
}

/** @brief 绑定的结果：参数名 → 值（开关为空数组）；bad 为参数名认不出、有歧义、多出位置参数、splatting 或缺值。 */
interface Bound {
  values: Map<string, Arg[]>;
  bad: boolean;
}

/** @brief 一个已按当时的当前目录解析、还没记下的重定向写入。 */
interface QueuedWrite {
  form: string;
  text: string;
  target: Target;
}

/**
 * @brief 命令名的归类（§7.4）：cmdlet（含别名、动词-名词形状与这条命令里定义的函数）、.ps1 脚本、外部程序，以及
 *        PowerShell 自带的换目录函数 location（cd..、cd\、cd~、A: … Z:，-NoProfile 时也有）。
 */
interface CommandInfo {
  kind: 'cmdlet' | 'script' | 'external' | 'location';
  /** cmdlet 的全名（location 为 Set-Location）；其他为去掉路径和 .exe 的名字（ScanLeave.command） */
  name: string;
  /** 比较用的小写名字（location 为函数名本身：'cd..'、'd:'） */
  key: string;
}

// ---- 常量 ----

/** @brief 单引号（PowerShell 也认弯引号，§7.3）。 */
const SQ: ReadonlySet<string> = new Set(["'", '‘', '’', '‚', '‛']);
/** @brief 双引号。 */
const DQ: ReadonlySet<string> = new Set(['"', '“', '”', '„']);
/** @brief 字符的类别（按字符码查 CLASS）：空白、参数模式里结束一个词的、词里要另外处理的（引号、$、`）。 */
const SPACE = 1;
const WORD_END = 2;
const WORD_STOP = 4;
/** @brief 管道一节以它开头时是表达式（§7.3；数字与 . 加数字另判，弯引号在 expressionStart 里另判）。 */
const EXPR_START = 8;
/** @brief 关键字的第一个字母（不分大小写）：不是它们时不必取出词来比较。 */
const KEYWORD_START = 16;
/** @brief 字母（关键字由字母组成）。 */
const LETTER = 32;
/** @brief 最长的关键字（function、continue）的长度。 */
const KEYWORD_MAX = 8;
/** @brief ASCII 字符的类别位；不换行空格与弯引号在 is() 里另判。 */
const CLASS = new Uint8Array(128);
for (const c of ' \t\r\f\v') CLASS[c.charCodeAt(0)] |= SPACE | WORD_END;
for (const c of '\n;|&(){},<>') CLASS[c.charCodeAt(0)] |= WORD_END;
for (const c of '\'"$`') CLASS[c.charCodeAt(0)] |= WORD_STOP;
for (const c of '$@([{!,+-\'"') CLASS[c.charCodeAt(0)] |= EXPR_START;
for (const c of 'iesfwdutcpbrIESFWDUTCPBR') CLASS[c.charCodeAt(0)] |= KEYWORD_START;
/** @brief 表达式里的名字与数字的字符（[A-Za-z0-9_]）。 */
const IDENT = 64;
for (let code = 65; code <= 122; code += 1) {
  if (code <= 90 || code >= 97) CLASS[code] |= LETTER | IDENT;
}
for (const c of '0123456789_') CLASS[c.charCodeAt(0)] |= IDENT;
/** @brief 只有字面参数的命令里的字符（Reader.plainElement）：字母、数字、_ - . \ / : 与空格、tab。 */
const PLAIN = 128;
for (let code = 0; code < 128; code += 1) {
  if ((CLASS[code] & IDENT) !== 0 || '-.\\/: \t'.includes(String.fromCharCode(code))) CLASS[code] |= PLAIN;
}
/** @brief 结束语句或管道一节的字符。 */
const STATEMENT_END = '\n;)}|';
/** @brief 关键字语句（§7.3）。 */
const KEYWORDS: ReadonlySet<string> = new Set([
  'if', 'elseif', 'else', 'switch', 'foreach', 'for', 'while', 'do', 'until', 'try', 'catch', 'finally', 'trap',
  'function', 'filter', 'param', 'begin', 'process', 'end', 'return', 'throw', 'break', 'continue', 'exit', 'class',
  'enum',
]);
/** @brief 跟在 } 之后、仍属于同一个关键字语句的关键字。 */
const CONTINUATIONS: ReadonlySet<string> = new Set(['elseif', 'else', 'catch', 'finally', 'while', 'until']);
/** @brief 数字字面量：以数字开头的语句是表达式而不是命令（7z 这类是命令）。 */
const NUMBER = /^(?:0x[0-9a-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?:[dlu]|kb|mb|gb|tb|pb)?$/i;
/** @brief 读关键字、函数名、赋值操作符与变量名的正则（sticky，用前设 lastIndex）。 */
const LETTERS = /[A-Za-z]+/y;
const FUNCTION_NAME = /[^\s(){};]+/y;
const ASSIGN_OP = /(?:[-+*/%]|\?\?)?=(?!=)/y;
const VAR_NAME = /[A-Za-z0-9_?]+(?::[A-Za-z0-9_?]+)?|[$^]/y;
/** @brief 双引号与参数里 ` 的转义。 */
const ESCAPES: Readonly<Record<string, string>> = {
  0: '\u0000', a: '\u0007', b: '\b', e: '\u001b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
};
/** @brief 赋值左边认得的变量（小写，不带 $）→ 它影响的名字。 */
const ASSIGNED: Readonly<Record<string, string>> = {
  'env:temp': 'TEMP', 'env:tmp': 'TMP', 'env:tmpdir': 'TMPDIR', pwd: 'PWD', 'env:cdpath': 'CDPATH',
  'env:git_dir': 'GIT_DIR', 'env:git_work_tree': 'GIT_WORK_TREE',
};
/** @brief 一段文字里最多记住多少个命令名的归类。 */
const CLASSIFY_CACHE = 1000;
/** @brief cmd.exe 再解析时当作重定向与命令连接的字符（§7.4）。 */
const CMD_META = /[<>|&]/;
/** @brief 删除或移走的 cmdlet：看不出来的参数、从管道来的目标也按删除记。 */
const REMOVERS: ReadonlySet<string> = new Set(['Remove-Item', 'Move-Item', 'Rename-Item']);
/**
 * @brief PowerShell 自带的换目录函数（5.1 与 7 的 -NoProfile 都有，cd~ 只有 7；本机 Get-Command 读出）：cd.. 是
 *        Set-Location ..，cd\ 是 Set-Location \，cd~ 是 Set-Location ~，A: … Z: 换到那个盘上的当前位置。它们不看参数。
 */
const LOCATION_FUNCTION = /^(?:cd\.\.|cd\\|cd~|[a-z]:)$/;
/** @brief 换目录的 cmdlet（Reader.location 处理）。 */
const LOCATION_CMDLETS: ReadonlySet<string> = new Set(['Set-Location', 'Push-Location', 'Pop-Location']);
/** @brief 嵌套 shell 的外部程序（Scan.shellArgs 分析）。 */
const SHELL_KEYS: ReadonlySet<string> = new Set(['bash', 'sh', 'pwsh', 'powershell']);
/** @brief if、try、do 之后的关键字。 */
const IF_WORDS: ReadonlySet<string> = new Set(['elseif', 'else']);
const TRY_WORDS: ReadonlySet<string> = new Set(['catch', 'finally']);
const DO_WORDS: ReadonlySet<string> = new Set(['while', 'until']);
/** @brief 用过 -StackName 之后的栈：之后 Pop-Location 回到哪里看不出来（弹的是别的栈，或换了默认的栈）。 */
const NAMED_STACK: CwdStack = { top: { dir: null, form: 'Pop-Location', text: 'Pop-Location' }, rest: null, depth: 1 };

/** @brief 字符 c（可以是 undefined）属于类别 mask。 */
function is(c: string | undefined, mask: number): boolean {
  if (c === undefined) return false;
  return codeIs(c.charCodeAt(0), mask);
}

/** @brief 文字 s 的第 at 个字符属于类别 mask；越界时不属于（逐字符扫描的循环用，不取出单个字符）。 */
function isAt(s: string, at: number, mask: number): boolean {
  return codeIs(s.charCodeAt(at), mask);
}

/** @brief 字符码 code（越界时为 NaN）属于类别 mask。 */
function codeIs(code: number, mask: number): boolean {
  if (code < 128) return (CLASS[code] & mask) !== 0;
  if (code === 0xa0) return (mask & (SPACE | WORD_END)) !== 0;
  return code >= 0x2018 && code <= 0x201e && (mask & WORD_STOP) !== 0;
}

/** @brief 一个 cmdlet 参数。 */
function param(name: string, role: Role, pos: number | null = null, aliases: string[] = [],
  group: string | null = null): Param {
  return { name, lower: name.toLowerCase(), aliases: aliases.map((alias) => alias.toLowerCase()), pos, role, group };
}

/** @brief 几个带值的参数。 */
function values(...names: string[]): Param[] {
  return names.map((name) => param(name, 'value'));
}

/** @brief 开关与通用参数（§7.5 参数规则第 1 条），每个 cmdlet 都有。 */
const COMMON: readonly Param[] = [
  ...['Force', 'Recurse', 'PassThru', 'NoNewline', 'Append', 'AsByteStream', 'Container']
    .map((name) => param(name, 'switch')),
  param('NoClobber', 'switch', null, ['NoOverwrite']),
  param('Verbose', 'switch', null, ['vb']), param('Debug', 'switch', null, ['db']),
  param('WhatIf', 'switch', null, ['wi']), param('Confirm', 'switch', null, ['cf']),
  param('UseTransaction', 'switch', null, ['usetx']),
  param('ErrorAction', 'value', null, ['ea']), param('WarningAction', 'value', null, ['wa']),
  param('InformationAction', 'value', null, ['infa']), param('ProgressAction', 'value', null, ['proga']),
  param('ErrorVariable', 'value', null, ['ev']), param('WarningVariable', 'value', null, ['wv']),
  param('InformationVariable', 'value', null, ['iv']), param('OutVariable', 'value', null, ['ov']),
  param('OutBuffer', 'value', null, ['ob']), param('PipelineVariable', 'value', null, ['pv']),
];

/** @brief Path（位置 0）与 LiteralPath（PSPath、LP）。 */
function pathParams(role: Role = 'path', name = 'Path', aliases: string[] = []): Param[] {
  const literal: Role = role === 'path' ? 'literal' : role;
  return [param(name, role, 0, aliases, 'path'), param('LiteralPath', literal, null, ['PSPath', 'LP'], 'path')];
}

/** @brief 一个 cmdlet 的参数表：加上 COMMON，排好位置参数，找出目标参数。 */
function spec(own: readonly Param[]): Spec {
  const params = [...own, ...COMMON];
  const slots = params.filter((p) => p.pos !== null).sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
  return { params, slots, targets: params.filter((p) => p.role === 'path' || p.role === 'literal') };
}

/** @brief Set-Content、Add-Content 的参数。 */
const CONTENT: Spec = spec([
  ...pathParams(), param('Value', 'value', 1),
  ...values('Filter', 'Include', 'Exclude', 'Credential', 'Encoding', 'Stream'),
]);
/** @brief Set-Location、Push-Location 的参数。 */
const LOCATION: Spec = spec([...pathParams(), param('StackName', 'value')]);

/** @brief 认得出的 cmdlet 与它们的参数表（§7.5、§7.7；本机 Get-Command 读出的 5.1 与 7 的并集）。 */
const SPECS: Readonly<Record<string, Spec>> = {
  'Set-Content': CONTENT,
  'Add-Content': CONTENT,
  'Out-File': spec([
    ...pathParams('path', 'FilePath', ['Path']), param('Encoding', 'value', 1), ...values('Width', 'InputObject'),
  ]),
  'Tee-Object': spec([
    ...pathParams('path', 'FilePath', ['Path']), ...values('InputObject', 'Encoding'), param('Variable', 'variable'),
  ]),
  'New-Item': spec([
    param('Path', 'path', 0), param('Name', 'name'), param('ItemType', 'value', null, ['Type']),
    param('Value', 'value', null, ['Target']), param('Credential', 'value'),
  ]),
  'Copy-Item': spec([
    ...pathParams('value'), param('Destination', 'dest', 1),
    ...values('Filter', 'Include', 'Exclude', 'Credential', 'FromSession', 'ToSession'),
  ]),
  'Move-Item': spec([
    ...pathParams(), param('Destination', 'dest', 1), ...values('Filter', 'Include', 'Exclude', 'Credential'),
  ]),
  'Remove-Item': spec([...pathParams(), ...values('Filter', 'Include', 'Exclude', 'Credential', 'Stream')]),
  'Rename-Item': spec([...pathParams(), param('NewName', 'newname', 1), param('Credential', 'value')]),
  'Set-Location': LOCATION,
  'Push-Location': LOCATION,
  'Pop-Location': spec([param('StackName', 'value')]),
  'Invoke-Expression': spec([param('Command', 'value', 0)]),
};

/** @brief 写入目标的 cmdlet（§7.5）。 */
const WRITERS: ReadonlySet<string> = new Set([
  'Set-Content', 'Add-Content', 'Out-File', 'Tee-Object', 'New-Item', 'Copy-Item', 'Move-Item', 'Remove-Item',
  'Rename-Item',
]);

/** @brief 别名 → cmdlet 全名（§7.5 的写法表、§7.7 的只读名单与换目录表、§7.4 的 iex）。 */
const ALIASES: Readonly<Record<string, string>> = aliasTable({
  'Set-Content': ['sc'], 'Add-Content': ['ac'], 'Tee-Object': ['tee'], 'New-Item': ['ni', 'mkdir', 'md'],
  'Copy-Item': ['cp', 'copy', 'cpi'], 'Move-Item': ['mv', 'move', 'mi'],
  'Remove-Item': ['rm', 'del', 'erase', 'rd', 'ri', 'rmdir'], 'Rename-Item': ['ren', 'rni'],
  'Set-Location': ['cd', 'chdir', 'sl'], 'Push-Location': ['pushd'], 'Pop-Location': ['popd'],
  'Invoke-Expression': ['iex'],
  'Get-ChildItem': ['ls', 'dir', 'gci'], 'Get-Content': ['cat', 'gc', 'type'], 'Get-Item': ['gi'],
  'Get-ItemProperty': ['gp'], 'Get-Location': ['pwd', 'gl'], 'Resolve-Path': ['rvpa'], 'Select-String': ['sls'],
  'Measure-Object': ['measure'], 'Compare-Object': ['compare', 'diff'], 'Select-Object': ['select'],
  'Where-Object': ['where', '?'], 'ForEach-Object': ['foreach', '%'], 'Sort-Object': ['sort'],
  'Group-Object': ['group'], 'Format-Table': ['ft'], 'Format-List': ['fl'], 'Format-Wide': ['fw'],
  'Write-Output': ['echo', 'write'], 'Get-Command': ['gcm'], 'Get-Help': ['help', 'man'],
  'Get-Process': ['gps', 'ps'], 'Get-Service': ['gsv'], 'Get-Variable': ['gv'], 'Get-Alias': ['gal'],
  'Start-Sleep': ['sleep'],
});

/** @brief 别名表：每个全名也按小写指向自己。 */
function aliasTable(groups: Record<string, string[]>): Record<string, string> {
  const table: Record<string, string> = {};
  for (const [name, aliases] of Object.entries(groups)) {
    table[name.toLowerCase()] = name;
    for (const alias of aliases) table[alias] = name;
  }
  return table;
}

/** @brief 引号里的一段字面。 */
function quoted(text: string): Piece {
  return { text, value: text, why: null, quoted: true, literal: true };
}

/** @brief 变量原文换成比较用的名字：去掉 $ 与花括号，小写（'$env:TEMP' → 'env:temp'）。 */
function varKey(raw: string): string {
  let start = 0;
  if (raw.startsWith('${')) start = 2;
  else if (raw.startsWith('$')) start = 1;
  const end = raw.length > start && raw.endsWith('}') ? raw.length - 1 : raw.length;
  return raw.slice(start, end).toLowerCase();
}

/** @brief 词里写出来的字面字符（cmd.exe 元字符的检查只看它们，§7.4）。 */
function literalText(arg: Arg): string {
  let text = '';
  for (const piece of arg.pieces) {
    if (piece.literal) text += piece.text;
  }
  return text;
}

/** @brief 参数名匹配（§7.5）：先按全名和别名精确匹配，再按全名的唯一前缀；认不出或有歧义时为 null。 */
function matchParam(params: readonly Param[], name: string): Param | null {
  const lower = name.toLowerCase();
  const exact = params.find((p) => p.lower === lower || p.aliases.includes(lower));
  if (exact) return exact;
  const found = params.filter((p) => p.lower.startsWith(lower));
  return found.length === 1 ? found[0] : null;
}

/** @brief 命名参数；返回多用掉的参数个数。 */
function bindNamed(params: readonly Param[], arg: Extract<PsArg, { k: 'param' }>, next: PsArg | undefined,
  bound: Bound): number {
  const found = matchParam(params, arg.name);
  if (!found) bound.bad = true;
  else if (found.role === 'switch') bound.values.set(found.name, []);
  else if (arg.value) bound.values.set(found.name, arg.value);
  else if (next?.k === 'value' && !next.end) {
    bound.values.set(found.name, next.items);
    return 1;
  } else bound.bad = true;
  return 0;
}

/** @brief 位置参数按位置依次绑定到还没绑的参数（同组的绑过一个就不再绑）；多出来的使整个绑定看不出来。 */
function bindPositional(table: Spec, positional: Arg[][], bound: Bound): void {
  const groupBound = (group: string | null): boolean =>
    group !== null && table.params.some((p) => p.group === group && bound.values.has(p.name));
  for (const items of positional) {
    const slot = table.slots.find((p) => !bound.values.has(p.name) && !groupBound(p.group));
    if (!slot) {
      bound.bad = true;
      return;
    }
    bound.values.set(slot.name, items);
  }
}

// ---- 读与处理 ----

/** @brief 读一段 PowerShell 文字并就地处理；引号、括号（含 {）、子表达式没有闭合时失败（§7.3）。 */
class Reader {
  private i = 0;
  /** classify 的结果（命令名 → 归类）；这条命令定义的函数个数变了时清空，最多留 CLASSIFY_CACHE 个 */
  private readonly classes = new Map<string, CommandInfo>();
  private classesFor = 0;
  /** 正在读参数的命令的重定向写入（已按当时的当前目录解析）：命令本身的目标之后再记（§7.2 按文字里的顺序）；还没有时为 null */
  private pending: QueuedWrite[] | null = null;
  /** 正在读参数的命令所在的层（不在读时为 -1）：更深的括号、脚本块、子表达式里的重定向照常就地记下 */
  private pendingLevel = -1;
  /** bind 上一次的参数表、参数与结果 */
  private lastBind: { table: Spec; args: PsArg[]; bound: Bound } | null = null;

  constructor(private readonly scan: Scan, private readonly s: string, private readonly run: Run,
    private level: number) {}

  /** @brief 整段文字。 */
  script(): void {
    this.statements(null, 'unclosed bracket');
  }

  private enter(): void {
    this.level = this.scan.deeper(this.level);
  }

  private leave(): void {
    this.level -= 1;
  }

  // ---- 空白与注释 ----

  /** @brief 跳过空白、` 加换行的续行、# 注释（到行尾）与 <# … #>。 */
  private spaces(): void {
    const s = this.s;
    for (;;) {
      const code = s.charCodeAt(this.i);
      if (code < 128 ? (CLASS[code] & SPACE) !== 0 : code === 0xa0) this.i += 1;
      else if (code === 0x60 && s[this.i + 1] === '\n') this.i += 2;
      else if (code === 0x60 && s[this.i + 1] === '\r' && s[this.i + 2] === '\n') this.i += 3;
      else if (code === 0x3c && s[this.i + 1] === '#') {
        const end = s.indexOf('#>', this.i + 2);
        this.i = end < 0 ? s.length : end + 2;
      } else if (code === 0x23) {
        const end = s.indexOf('\n', this.i);
        this.i = end < 0 ? s.length : end;
      } else return;
    }
  }

  /** @brief 跳过空白与换行。 */
  private lines(): void {
    for (;;) {
      this.spaces();
      if (this.s[this.i] !== '\n') return;
      this.i += 1;
    }
  }

  /** @brief 跳过空白、换行与 ;。 */
  private breaks(): void {
    for (;;) {
      this.spaces();
      const c = this.s[this.i];
      if (c !== '\n' && c !== ';') return;
      this.i += 1;
    }
  }

  /** @brief 当前位置在语句或管道一节的末尾。 */
  private atEnd(): boolean {
    const c = this.s[this.i];
    return c === undefined || STATEMENT_END.includes(c) || c === '&';
  }

  // ---- 语句 ----

  /** @brief 语句列表：到 close 为止；close 为 null 时到文字末尾，否则没有闭合时按 reason 失败。 */
  private statements(close: ')' | '}' | null, reason: FailReason): void {
    for (;;) {
      this.breaks();
      const c = this.s[this.i];
      if (c === undefined) {
        if (close !== null) this.scan.fail(reason);
        return;
      }
      if (c === close) {
        this.i += 1;
        return;
      }
      const before = this.i;
      if (c !== ')' && c !== '}') this.statement();
      if (this.i === before) this.i += 1;
    }
  }

  /** @brief 一条语句：关键字语句或管道链。 */
  private statement(): void {
    const keyword = this.keyword();
    if (keyword !== null) this.keywordStatement(keyword);
    else this.chain(true);
  }

  /** @brief 当前位置的关键字（不消耗）；不是时为 null。 */
  private keyword(): string | null {
    const s = this.s;
    const start = this.i;
    if ((CLASS[s.charCodeAt(start)] & KEYWORD_START) === 0) return null;
    let end = start + 1;
    while (end - start <= KEYWORD_MAX && (CLASS[s.charCodeAt(end)] & LETTER) !== 0) end += 1;
    if (end - start > KEYWORD_MAX) return null;
    const word = s.slice(start, end).toLowerCase();
    const after = s[end];
    if (!KEYWORDS.has(word) || (after !== undefined && !/[\s;(){}]/.test(after))) return null;
    return word;
  }

  /**
   * @brief 关键字语句（§7.3）：跳过关键字，( … ) 按语句分析，{ … } 按语句列表分析；if、try、switch 与循环按 §7.7 算出
   *        几种可能的当前目录。
   */
  private keywordStatement(keyword: string): void {
    this.i += keyword.length;
    this.spaces();
    if (keyword === 'return' || keyword === 'throw' || keyword === 'exit') this.chain(false);
    else if (keyword === 'break' || keyword === 'continue') this.token();
    else if (keyword === 'switch') this.switchStatement();
    else if (keyword === 'class' || keyword === 'enum') this.typeStatement();
    else if (keyword === 'if') this.ifStatement();
    else if (keyword === 'try') this.tryStatement();
    else if (keyword === 'foreach' || keyword === 'for' || keyword === 'while') this.loopStatement(keyword);
    else if (keyword === 'do') this.doStatement();
    else {
      if (keyword === 'function' || keyword === 'filter') this.functionName();
      this.keywordParts();
    }
  }

  /** @brief 现在的几种可能。 */
  private save(): State[] {
    return this.scan.statesOf(this.run);
  }

  /** @brief 设成这几种可能。 */
  private restore(states: readonly State[]): void {
    this.scan.setStates(this.run, states);
  }

  /** @brief 当前位置是 ( 时读 ( … )；之后跳过空白。 */
  private optionalParen(): void {
    this.spaces();
    if (this.s[this.i] === '(') this.paren(')', 1, 'unclosed bracket');
    this.spaces();
  }

  /** @brief 下一个记号（可以隔着换行）是 { 时读 { … } 并返回真；不是时位置不变。 */
  private optionalBlock(): boolean {
    const save = this.i;
    this.lines();
    if (this.s[this.i] !== '{') {
      this.i = save;
      return false;
    }
    this.block();
    return true;
  }

  /**
   * @brief if / elseif / else（§7.7）：每个条件从前面的条件都不成立时的可能跑（含条件之前的），主体从它的条件跑完时的
   *        可能跑；结束时取各个主体与 else（没有 else 时为都不成立）的并。
   */
  private ifStatement(): void {
    let failed = this.save();
    let ends: State[] = [];
    for (;;) {
      this.optionalParen();
      failed = this.scan.union(failed, this.save());
      if (!this.optionalBlock()) break;
      ends = this.scan.union(ends, this.save());
      const word = this.continuation(IF_WORDS);
      if (word === null) break;
      this.restore(failed);
      if (word === 'else') {
        this.optionalBlock();
        this.restore(this.scan.union(ends, this.save()));
        return;
      }
    }
    this.restore(this.scan.union(ends, failed));
  }

  /**
   * @brief try / catch / finally（§7.7）：catch 从进入时与 try 跑完时的可能跑；finally 从到那时的全部可能跑，它跑完的
   *        就是结束时的；没有 finally 时结束时取 try 与各个 catch 跑完时的并。catch 的类型 [T] 照样读。
   */
  private tryStatement(): void {
    const entry = this.save();
    this.optionalBlock();
    let ends = this.save();
    let all = this.scan.union(entry, ends);
    for (;;) {
      const word = this.continuation(TRY_WORDS);
      if (word === null) break;
      this.restore(all);
      this.spaces();
      while (this.s[this.i] === '[' || this.s[this.i] === ',') {
        this.step();
        this.spaces();
      }
      this.optionalBlock();
      const out = this.save();
      all = this.scan.union(all, out);
      ends = word === 'finally' ? out : this.scan.union(ends, out);
    }
    this.restore(ends);
  }

  /**
   * @brief foreach / for / while（§7.7，Scan.loop）：foreach 的 ( … ) 只算一次；for、while 的 ( … ) 与主体每一轮都跑。
   */
  private loopStatement(keyword: string): void {
    if (keyword === 'foreach') this.optionalParen();
    const start = this.i;
    this.scan.loop(this.run, () => {
      this.i = start;
      if (keyword !== 'foreach') this.optionalParen();
      this.optionalBlock();
    });
  }

  /** @brief do { … } while / until ( … )：主体与条件每一轮都跑（Scan.loop）。 */
  private doStatement(): void {
    const start = this.i;
    this.scan.loop(this.run, () => {
      this.i = start;
      this.optionalBlock();
      if (this.continuation(DO_WORDS) !== null) this.optionalParen();
    });
  }

  /** @brief 其余关键字（function、filter、trap、param 这类）之后的部分；} 之后跟着 else、catch、while 这类时继续。 */
  private keywordParts(): void {
    for (;;) {
      this.spaces();
      const c = this.s[this.i];
      if (c === '(') this.paren(')', 1, 'unclosed bracket');
      else if (c === '{') {
        this.block();
        if (this.continuation(CONTINUATIONS) === null) return;
      } else if (c === undefined || STATEMENT_END.includes(c)) return;
      else this.step();
    }
  }

  /** @brief } 之后（可以隔着换行）的 words 之一（elseif、else、catch、finally、while、until）：吃掉它并返回它；不是时为 null。 */
  private continuation(words: ReadonlySet<string>): string | null {
    const save = this.i;
    this.lines();
    LETTERS.lastIndex = this.i;
    const word = LETTERS.exec(this.s)?.[0].toLowerCase();
    if (word !== undefined && words.has(word)) {
      this.i = LETTERS.lastIndex;
      return word;
    }
    this.i = save;
    return null;
  }

  /** @brief function / filter 的名字：记下来，之后用这个名字的命令算函数（§7.4）。 */
  private functionName(): void {
    FUNCTION_NAME.lastIndex = this.i;
    const found = FUNCTION_NAME.exec(this.s);
    if (!found) return;
    this.i = FUNCTION_NAME.lastIndex;
    this.run.functions.add(found[0].replace(/^[A-Za-z]+:/, '').toLowerCase());
  }

  /**
   * @brief switch [选项] (…) { 条件 { 动作 } … }：(…) 只算一次；switch 对输入的每一项各跑一遍各个条件，所以 { … } 按循环
   *        走（Scan.loop）。
   */
  private switchStatement(): void {
    for (;;) {
      this.spaces();
      const c = this.s[this.i];
      if (c === '{') {
        const start = this.i;
        this.scan.loop(this.run, () => {
          this.i = start;
          this.body(true);
        });
        return;
      }
      if (c === undefined || STATEMENT_END.includes(c)) return;
      if (c === '(') this.paren(')', 1, 'unclosed bracket');
      else this.step();
    }
  }

  /** @brief class / enum：名字之后的 { … } 里，方法体与括号照样分析。 */
  private typeStatement(): void {
    for (;;) {
      this.spaces();
      const c = this.s[this.i];
      if (c === '{') {
        this.body(false);
        return;
      }
      if (c === undefined || STATEMENT_END.includes(c)) return;
      this.step();
    }
  }

  /**
   * @brief switch 与 class / enum 的 { … }：逐个记号读，其中的 { … }、( … ) 照样分析；clauses 为 switch 的“条件 { 动作 }”：
   *        对上的几条依次都跑，所以每条从进入时与前面各条跑完时的可能跑（§7.7），结束时取这些的并。
   */
  private body(clauses: boolean): void {
    this.i += 1;
    this.enter();
    let all = clauses ? this.save() : null;
    for (;;) {
      this.breaks();
      const c = this.s[this.i];
      if (c === undefined) this.scan.fail('unclosed bracket');
      if (c === '}') {
        this.i += 1;
        break;
      }
      if (all) this.restore(all);
      this.step();
      this.spaces();
      if (clauses && this.s[this.i] === '{') this.block();
      if (all) all = this.scan.union(all, this.save());
    }
    if (all) this.restore(all);
    this.leave();
  }

  /** @brief 读一个记号；没有前进时跳过一个字符。 */
  private step(): void {
    const before = this.i;
    this.token();
    if (this.i === before) this.i += 1;
  }

  /**
   * @brief 管道链：管道用 && / || 连接（当前目录按 §7.7 的 && / || 规则，Scan.chain）；末尾的 & 是后台作业
   *        （后台作业在另一个运行空间里，位置不影响这里，偏严照样延续）。
   */
  private chain(statementStart: boolean): void {
    const start = this.run.alts.length === 0 ? null : this.save();
    const cwd = this.run.cwd;
    const stack = this.run.stack;
    this.pipeline(statementStart);
    let chain: Chain | null = null;
    for (;;) {
      this.spaces();
      const or = this.s.startsWith('||', this.i);
      if (!or && !this.s.startsWith('&&', this.i)) break;
      if (!chain) {
        chain = this.scan.chain(this.run, start ?? [{ cwd, stack }]);
        chain.next(false);
      }
      this.i += 2;
      this.lines();
      chain.next(or);
      this.pipeline(false);
    }
    chain?.end();
    if (this.s[this.i] === '&') this.i += 1;
  }

  /** @brief 管道：| 连接的几节；第二节起从管道读输入。 */
  private pipeline(statementStart: boolean): void {
    let piped = false;
    for (;;) {
      this.spaces();
      this.element(statementStart && !piped, piped);
      this.spaces();
      if (this.s[this.i] !== '|' || this.s[this.i + 1] === '|') return;
      this.i += 1;
      this.lines();
      piped = true;
    }
  }

  /** @brief 管道的一节：按每一个可能的当前目录各读一遍（§7.7，Scan.eachState；读的位置每次放回开头）。 */
  private element(statementStart: boolean, piped: boolean): void {
    if (this.run.alts.length === 0) {
      this.elementOnce(statementStart, piped);
      return;
    }
    if (this.plainElement(piped)) return;
    const start = this.i;
    this.scan.eachState(this.run, () => {
      this.i = start;
      this.elementOnce(statementStart, piped);
    });
  }

  /**
   * @brief 几个可能时的捷径（结果同逐个读）：这一节是字母开头的命令，到这一节的末尾只有 PLAIN 的字符（没有引号、变量、
   *        子表达式、重定向与注释）时，读的时候没有要记的东西，读一遍就够，各个可能下只按命令名处理。
   *        不是这种节时为假，读的位置不动。
   */
  private plainElement(piped: boolean): boolean {
    const s = this.s;
    if ((CLASS[s.charCodeAt(this.i)] & LETTER) === 0) return false;
    let j = this.i;
    while (j < s.length && (CLASS[s.charCodeAt(j)] & PLAIN) !== 0) j += 1;
    if (j < s.length && !STATEMENT_END.includes(s[j]) && s[j] !== '&') return false;
    const name = this.word();
    const args = this.args();
    const info = this.classify(this.scan.valueOrText(name));
    if (info.kind === 'external') this.metachar(args);
    if (this.isSpecial(info) || (info.kind === 'cmdlet' && WRITERS.has(info.name))) {
      this.scan.eachState(this.run, () => this.handle(name, args, piped));
    } else this.scan.eachLeave(this.run, this.readOnly(info, args) ? null : info.name);
    return true;
  }

  /** @brief 管道的一节（§7.3）：& / . 开头是调用；$、引号、数字、(、[、@ 开头是表达式；裸词开头是命令。 */
  private elementOnce(statementStart: boolean, piped: boolean): void {
    const s = this.s;
    const c = s[this.i];
    if (c === undefined || STATEMENT_END.includes(c) || s.startsWith('&&', this.i)) return;
    if (c === '&' || (c === '.' && /[ \t]/.test(s[this.i + 1] ?? ''))) {
      this.call(piped);
      return;
    }
    if (this.expressionStart()) {
      const result = this.expression(statementStart);
      if (result.assign) this.assignment(result.lhs);
      return;
    }
    this.command(this.word(), piped);
  }

  /** @brief 这一节以表达式开头。 */
  private expressionStart(): boolean {
    const s = this.s;
    const code = s.charCodeAt(this.i);
    if (code >= 128) return SQ.has(s[this.i]) || DQ.has(s[this.i]);
    if ((CLASS[code] & EXPR_START) !== 0) return true;
    if (code === 0x2e) return /\d/.test(s[this.i + 1] ?? '');
    if (!(code >= 0x30 && code <= 0x39)) return false;
    let j = this.i;
    while (j < s.length && !isAt(s, j, WORD_END)) j += 1;
    return NUMBER.test(s.slice(this.i, j));
  }

  // ---- 表达式 ----

  /**
   * @brief 表达式：其中的 $( )、@( )、( )、{ }、@{ } 照样分析，重定向照样记（§7.5）。
   * @param statementStart 在语句开头：遇到赋值操作符时停下
   * @return assign 为遇到赋值；lhs 为只有一个变量在左边时它的名字（小写，不带 $）
   */
  private expression(statementStart: boolean): { assign: boolean; lhs: string | null } {
    let lhs: string | null = null;
    let count = 0;
    for (;;) {
      this.spaces();
      if (this.atEnd()) return { assign: false, lhs };
      if (statementStart && this.assignOp()) return { assign: true, lhs: count === 1 ? lhs : null };
      if (this.redirect()) continue;
      const before = this.i;
      const name = this.token();
      if (count === 0) lhs = name;
      count += 1;
      if (this.i === before) this.i += 1;
    }
  }

  /** @brief 赋值操作符（= += -= *= /= %= ??=）：吃掉它并返回真。 */
  private assignOp(): boolean {
    const s = this.s;
    if (s[this.i] !== '=' && s[this.i + 1] !== '=' && s[this.i + 2] !== '=') return false;
    ASSIGN_OP.lastIndex = this.i;
    if (!ASSIGN_OP.exec(this.s)) return false;
    this.i = ASSIGN_OP.lastIndex;
    return true;
  }

  /** @brief 表达式里的一个记号；是变量时返回它的名字（小写，不带 $），否则为 null。 */
  private token(): string | null {
    const s = this.s;
    const c = s[this.i];
    const start = this.i;
    if (c === undefined) return null;
    if (SQ.has(c)) this.single();
    else if (DQ.has(c)) this.double([], null);
    else if (c === '@') this.at();
    else if (c === '$') return this.variable(true).why === 'substitution' ? null : varKey(s.slice(start, this.i));
    else if (c === '(') this.paren(')', 1, 'unclosed bracket');
    else if (c === '{') this.block();
    else if (c === '[') this.bracket();
    else if (isAt(s, start, IDENT) || (c === '-' && isAt(s, start + 1, LETTER))) {
      this.i += 1;
      while (isAt(s, this.i, IDENT)) this.i += 1;
    } else this.i += 1;
    return null;
  }

  /** @brief @ 开头的：@( )、@{ }、here-string；其他（@名字）跳过 @。 */
  private at(): void {
    const next = this.s[this.i + 1];
    if (next === '(') this.paren(')', 2, 'unclosed bracket');
    else if (next === '{') this.hashtable();
    else if (next === "'" || next === '"') this.hereString();
    else this.i += 1;
  }

  /** @brief ( … )、$( … )、@( … )：语句列表。 */
  private paren(close: ')', skip: number, reason: FailReason): void {
    this.i += skip;
    this.enter();
    this.statements(close, reason);
    this.leave();
  }

  /** @brief 脚本块 { … }：任何地方都当作会被执行，就地分析（§7.3）。 */
  private block(): void {
    this.i += 1;
    this.enter();
    this.statements('}', 'unclosed bracket');
    this.leave();
  }

  /** @brief [ … ]：类型或下标，里面的子表达式照样分析。 */
  private bracket(): void {
    this.i += 1;
    this.enter();
    for (;;) {
      this.lines();
      const c = this.s[this.i];
      if (c === undefined) this.scan.fail('unclosed bracket');
      if (c === ']') {
        this.i += 1;
        break;
      }
      this.step();
    }
    this.leave();
  }

  /** @brief @{ 键 = 值; … }：值按语句分析。 */
  private hashtable(): void {
    this.i += 2;
    this.enter();
    for (;;) {
      this.breaks();
      const c = this.s[this.i];
      if (c === undefined) this.scan.fail('unclosed bracket');
      if (c === '}') {
        this.i += 1;
        break;
      }
      const before = this.i;
      this.token();
      this.spaces();
      if (this.s[this.i] === '=') {
        this.i += 1;
        this.lines();
        this.statement();
      }
      if (this.i === before) this.i += 1;
    }
    this.leave();
  }

  /** @brief 赋值：$env:TEMP / TMP / TMPDIR 与 $pwd 从此看不出来，$env:CDPATH 记下，$env:GIT_DIR / GIT_WORK_TREE 记值；右边按语句分析。 */
  private assignment(lhs: string | null): void {
    this.lines();
    const name = lhs !== null && Object.hasOwn(ASSIGNED, lhs) ? ASSIGNED[lhs] : null;
    if (name === 'GIT_DIR' || name === 'GIT_WORK_TREE') {
      this.scan.gitEnv.set(name, { arg: this.gitValue(), shell: 'powershell' });
      return;
    }
    if (name === 'CDPATH') this.scan.cdpath = true;
    else if (name !== null) this.scan.markVar(name);
    this.rightSide();
  }

  /** @brief 赋值的右边按语句分析（多一层嵌套：$a = $b = … 一长串不会递归过深）。 */
  private rightSide(): void {
    this.enter();
    this.statement();
    this.leave();
  }

  /** @brief $env:GIT_DIR = 的右边：只有一个字面的值时为它，否则按语句分析、值看不出来。 */
  private gitValue(): Arg {
    const s = this.s;
    const start = this.i;
    let end = start;
    while (end < s.length && !'\n;}'.includes(s[end])) end += 1;
    if (!/[({]/.test(s.slice(start, end))) {
      const items = this.values();
      this.spaces();
      if (items.length === 1 && (this.i >= s.length || '\n;}'.includes(s[this.i]))) return items[0];
      this.i = start;
    }
    this.rightSide();
    return this.scan.unknown(s.slice(start, this.i).trim(), 'variable');
  }

  // ---- 命令 ----

  /** @brief & / . 调用：{ 块 } 就地分析；变量或子表达式解析失败；字面的名字照常。 */
  private call(piped: boolean): void {
    this.i += 1;
    this.spaces();
    const c = this.s[this.i];
    if (c === '{') {
      this.block();
      this.args();
      return;
    }
    if (c === '$' || c === '(' || c === '@') this.scan.fail('the command name comes from a variable or substitution');
    this.command(this.word(), piped);
  }

  /**
   * @brief 一条命令：读完参数（其中的重定向按当时的当前目录解析，先留着）再按命令名处理，最后记重定向写入
   *        （Remove-Item x 2> e 先 Remove-Item 后 2>）。
   */
  private command(name: Arg, piped: boolean): void {
    const outer = this.pending;
    const outerLevel = this.pendingLevel;
    this.pending = null;
    this.pendingLevel = this.level;
    const args = this.args();
    const queued = this.pending as QueuedWrite[] | null;
    this.pending = outer;
    this.pendingLevel = outerLevel;
    this.handle(name, args, piped);
    for (const write of queued ?? []) this.scan.write(write.form, write.text, write.target, false, false);
  }

  /** @brief 按命令名处理一条命令（§7.4、§7.5、§7.7）：换目录、iex、git、嵌套 shell、认得出的 cmdlet 与 leave。 */
  private handle(name: Arg, args: PsArg[], piped: boolean): void {
    if (name.pieces.length === 0) return;
    for (const piece of name.pieces) {
      if (piece.why !== null) this.scan.fail('the command name comes from a variable or substitution');
    }
    const info = this.classify(this.scan.valueOrText(name));
    if (info.kind === 'external') this.metachar(args);
    if (this.special(info, name, args, piped)) return;
    if (info.kind === 'cmdlet' && WRITERS.has(info.name)) this.cmdlet(info.name, args);
    if (!this.readOnly(info, args)) this.scan.leave(this.run.cwd, info.name);
  }

  /**
   * @brief 不记 leave 的命令：只读名单（§7.7）；ForEach-Object 只在参数都是脚本块或参数名（-MemberName 除外）时算，
   *        按成员名调用（ForEach-Object Delete）会调对象的方法（§7.7 末尾第 4 条）。
   */
  private readOnly(info: CommandInfo, args: PsArg[]): boolean {
    if (!this.scan.readOnly('powershell', info.key)) return false;
    if (info.key !== 'foreach-object') return true;
    return args.every((arg) => (arg.k === 'param' ? !/^m/i.test(arg.name) && arg.value === null
      : arg.k === 'value' && arg.items.every((item) => this.scan.text(item).startsWith('{'))));
  }

  /**
   * @brief 命令名的归类（§7.4）：去掉模块限定与 .exe，别名换成全名；.ps1 是脚本；其余不是 cmdlet 形状的是外部程序。
   *        写明 .exe 的（where.exe、sort.exe）一定是外部程序：PowerShell 不拿它找别名与函数。
   */
  private classify(value: string): CommandInfo {
    if (this.classesFor !== this.run.functions.size) {
      this.classes.clear();
      this.classesFor = this.run.functions.size;
    }
    const cached = this.classes.get(value);
    if (cached) return cached;
    const info = this.classifyName(value);
    if (this.classes.size < CLASSIFY_CACHE) this.classes.set(value, info);
    return info;
  }

  /** @brief classify 的计算；自带的换目录函数（cd..、cd\、cd~、D:）先于模块限定与路径的判断。 */
  private classifyName(value: string): CommandInfo {
    const raw = value.toLowerCase();
    if (LOCATION_FUNCTION.test(raw)) return { kind: 'location', name: 'Set-Location', key: raw };
    const pathLike = /^(?:\.{1,2}[\\/]|[\\/]|~|[A-Za-z]:)/.test(value);
    const base = (pathLike ? value.split(/[\\/]/) : value.split('\\')).pop() ?? '';
    const lower = base.toLowerCase();
    const named = !pathLike && !lower.endsWith('.exe');
    const key = lower.replace(/\.exe$/, '');
    if (key.endsWith('.ps1')) return { kind: 'script', name: base, key };
    if (named && Object.hasOwn(ALIASES, key)) {
      const name = ALIASES[key];
      return { kind: 'cmdlet', name, key: name.toLowerCase() };
    }
    if (named && (/^[a-z]+-[a-z]+$/.test(key) || this.run.functions.has(key))) {
      return { kind: 'cmdlet', name: base, key };
    }
    const label = (base.split('/').pop() ?? base).replace(/\.exe$/i, '');
    return { kind: 'external', name: label, key: label.toLowerCase() };
  }

  /** @brief special 处理的命令：自带的换目录函数、Set-Location / Push-Location / Pop-Location、Invoke-Expression、git 与嵌套 shell。 */
  private isSpecial(info: CommandInfo): boolean {
    if (info.kind === 'location') return true;
    if (info.kind === 'cmdlet') return LOCATION_CMDLETS.has(info.name) || info.name === 'Invoke-Expression';
    return info.kind === 'external' && (info.key === 'git' || SHELL_KEYS.has(info.key));
  }

  /** @brief 换目录、Invoke-Expression、git 与嵌套 shell（isSpecial）；处理了时为真。 */
  private special(info: CommandInfo, name: Arg, args: PsArg[], piped: boolean): boolean {
    if (!this.isSpecial(info)) return false;
    if (info.kind === 'location') this.run.cwd = this.locationFunction(info.key);
    else if (info.kind === 'cmdlet') {
      if (info.name === 'Invoke-Expression') this.invoke(args);
      else this.location(info.name, args, piped);
    } else if (info.key === 'git') this.scan.git(this.plain(args), this.run.cwd, 'powershell', {});
    else {
      const stdin = { kind: piped ? 'unknown' : 'none', text: '' } as const;
      const call = { cwd: this.run.cwd, level: this.level, stdin, env: {} };
      if (this.scan.shellArgs(info.key, [name, ...this.plain(args)], call) === 'script') {
        this.scan.leave(this.run.cwd, info.name);
      }
    }
    return true;
  }

  /** @brief 交给外部程序的参数：-名字 原样，数组的每一项一个参数，splatting 看不出来。 */
  private plain(args: PsArg[]): Arg[] {
    return args.flatMap((arg): Arg[] => {
      if (arg.k === 'splat') return [this.scan.unknown(arg.raw, 'variable')];
      if (arg.k === 'value') return arg.items;
      if (!arg.value) return [this.scan.lit(`-${arg.name}`)];
      return [{ pieces: [...this.scan.lit(`-${arg.name}:`).pieces, ...arg.value.flatMap((item) => item.pieces)] }];
    });
  }

  /** @brief 外部程序的参数去掉引号后不含空白、却含 > < | & 时解析失败（§7.4）。 */
  private metachar(args: PsArg[]): void {
    for (const arg of args) {
      if (arg.k === 'value') {
        for (const item of arg.items) this.metacharText(literalText(item));
      } else if (arg.k === 'param') {
        this.metacharText(`-${arg.name}${arg.value ? `:${arg.value.map(literalText).join(',')}` : ''}`);
      }
    }
  }

  /** @brief 一个参数的文字：含 > < | & 且不含空白时解析失败。 */
  private metacharText(text: string): void {
    if (CMD_META.test(text) && !/\s/.test(text)) this.scan.fail('cmd.exe metacharacter in an argument');
  }

  /**
   * @brief 自带的换目录函数换到的目录：cd.. 与 cd\ 同 Set-Location .. / \；cd~ 去用户目录（看不出来）；D: 换到那个盘上的
   *        当前位置：与当前目录同盘时不动，否则看不出来。
   */
  private locationFunction(key: string): Cwd {
    const form = 'Set-Location';
    if (key === 'cd..' || key === 'cd\\') {
      const text = key.slice(2);
      const target = this.scan.resolve(this.scan.lit(text), this.run.cwd, 'powershell', true);
      return { dir: target?.path ?? null, form, text };
    }
    if (key === 'cd~') return { dir: null, form, text: '~' };
    const dir = this.run.cwd.dir;
    if (dir !== null && dir.slice(0, 2).toLowerCase() === key) return this.run.cwd;
    return { dir: null, form, text: key.toUpperCase() };
  }

  /**
   * @brief Set-Location、Push-Location、Pop-Location（§7.7）。用过 -StackName 之后（弹的是别的栈，或 Set-Location
   *        -StackName 换了默认的栈）栈换成 NAMED_STACK：之后 Pop-Location 回到哪里看不出来。
   */
  private location(name: string, args: PsArg[], piped: boolean): void {
    const bound = this.bind(SPECS[name], args);
    const named = bound.values.has('StackName');
    if (name === 'Pop-Location') {
      const stack = named ? NAMED_STACK : this.run.stack;
      this.run.cwd = stack?.top ?? { dir: null, form: name, text: name };
      this.run.stack = named ? NAMED_STACK : (stack?.rest ?? null);
      return;
    }
    const next = this.locationTarget(name, bound, piped);
    if (name === 'Push-Location' && !named) this.run.stack = this.scan.push(this.run.stack, this.run.cwd);
    if (named) this.run.stack = NAMED_STACK;
    if (next) this.run.cwd = next;
  }

  /**
   * @brief 换到的目录；Set-Location 没有参数、-、+ 时看不出来；Path 从管道绑定（'..' | Push-Location）时看不出来
   *        （input）；Push-Location 没有参数也不从管道读时不换（为 null）。
   */
  private locationTarget(form: string, bound: Bound, piped: boolean): Cwd | null {
    if (bound.bad) return { dir: null, form, text: `(unrecognized parameters of ${form})` };
    const literal = bound.values.get('LiteralPath');
    const item = (literal ?? bound.values.get('Path'))?.[0];
    if (!item && piped) return { dir: null, form, text: '(paths from input)' };
    if (!item) return form === 'Set-Location' ? { dir: null, form, text: '~' } : null;
    const text = this.scan.text(item);
    const value = this.scan.valueOf(item);
    if (value === '-' || value === '+') return { dir: null, form, text };
    const from = this.run.cwd;
    return this.scan.moveTo(item, from, form, () => {
      return { dir: this.scan.resolve(item, from, 'powershell', literal !== undefined)?.path ?? null, form, text };
    });
  }

  /** @brief Invoke-Expression [-Command] 文字：按 PowerShell 分析（在当前运行空间里执行，位置延续）；不是字面量时解析失败。 */
  private invoke(args: PsArg[]): void {
    const bound = this.bind(SPECS['Invoke-Expression'], args);
    const items = bound.values.get('Command');
    if (bound.bad || !items || items.length !== 1) this.scan.fail('the command text comes from a variable or input');
    scanPsText(this.scan, this.scan.mustText(items[0]), this.run, this.scan.deeper(this.level));
  }

  /**
   * @brief 按参数表绑定（§7.5 参数规则）。结果只读；同一个参数表与同一组参数（plainElement 让几个可能共用一次读出的
   *        参数）直接给上一次的结果。
   */
  private bind(table: Spec, args: PsArg[]): Bound {
    if (this.lastBind?.table === table && this.lastBind.args === args) return this.lastBind.bound;
    const bound: Bound = { values: new Map(), bad: false };
    const positional: Arg[][] = [];
    let ended = false;
    for (let k = 0; k < args.length; k += 1) {
      const arg = args[k];
      if (arg.k === 'splat') bound.bad = true;
      else if (arg.k === 'value') {
        if (arg.end && !ended) ended = true;
        else positional.push(arg.items);
      } else if (ended) positional.push([this.scan.lit(`-${arg.name}`)]);
      else k += bindNamed(table.params, arg, args[k + 1], bound);
    }
    bindPositional(table, positional, bound);
    this.lastBind = { table, args, bound };
    return bound;
  }

  // ---- 认得出的 cmdlet（§7.5） ----

  /** @brief 一个写入的 cmdlet：参数看不出来时只出一个 parameter 目标。 */
  private cmdlet(name: string, args: PsArg[]): void {
    const bound = this.bind(SPECS[name], args);
    const remove = REMOVERS.has(name);
    if (bound.bad) {
      this.scan.write(name, `(unrecognized parameters of ${name})`, { path: null, why: 'parameter' }, remove, false);
      return;
    }
    if (name === 'New-Item') this.newItem(bound);
    else if (name === 'Rename-Item') this.rename(bound);
    else if (name === 'Copy-Item') this.destination(name, bound);
    else if (name !== 'Tee-Object' || this.hasPath(name, bound) || !bound.values.has('Variable')) {
      this.paths(name, bound, remove);
      if (name === 'Move-Item') this.destination(name, bound);
    }
  }

  /** @brief 给了 Path 或 LiteralPath（Out-File、Tee-Object 为 FilePath）。 */
  private hasPath(name: string, bound: Bound): boolean {
    return SPECS[name].targets.some((p) => bound.values.has(p.name));
  }

  /** @brief 记一个目标。 */
  private put(form: string, arg: Arg, remove: boolean, literal: boolean, into: boolean): Target | null {
    const target = this.scan.resolve(arg, this.run.cwd, 'powershell', literal);
    if (target) this.scan.write(form, this.scan.text(arg), target, remove, into);
    return target;
  }

  /** @brief Path / LiteralPath 的每一项；都没有给时是从管道来的目标。 */
  private paths(form: string, bound: Bound, remove: boolean): Target[] {
    const found: Target[] = [];
    for (const p of SPECS[form].targets) {
      for (const item of bound.values.get(p.name) ?? []) {
        const target = this.put(form, item, remove, p.role === 'literal', false);
        if (target) found.push(target);
      }
    }
    if (!this.hasPath(form, bound)) {
      this.scan.write(form, '(paths from input)', { path: null, why: 'input' }, remove, false);
    }
    return found;
  }

  /** @brief Copy-Item / Move-Item 的 Destination；没有时为当前目录（落进目录，text '.'）。 */
  private destination(form: string, bound: Bound): void {
    const items = bound.values.get('Destination');
    if (items) {
      for (const item of items) this.put(form, item, false, false, this.scan.intoDir(item));
      return;
    }
    const dir = this.run.cwd.dir;
    this.scan.write(form, '.', dir === null ? { path: null, why: 'directory' } : { path: dir, why: null }, false, true);
  }

  /** @brief New-Item：每个 Path；有 Name 时为 Path\Name；只有 Name 时为当前目录\Name。 */
  private newItem(bound: Bound): void {
    const name = bound.values.get('Name')?.[0];
    const paths = bound.values.get('Path');
    if (!paths) {
      if (name) this.put('New-Item', name, false, false, false);
      else this.scan.write('New-Item', '(paths from input)', { path: null, why: 'input' }, false, false);
      return;
    }
    for (const item of paths) {
      if (!name) {
        this.put('New-Item', item, false, false, false);
        continue;
      }
      const base = this.scan.resolve(item, this.run.cwd, 'powershell', false);
      const parent: Cwd = { dir: base?.path ?? null, form: null, text: '' };
      const target = base && base.path === null ? base : this.scan.resolve(name, parent, 'powershell', false);
      if (target) this.scan.write('New-Item', `${this.scan.text(item)}\\${this.scan.text(name)}`, target, false, false);
    }
  }

  /** @brief Rename-Item：原名（删除）加上“原名所在目录\NewName”。 */
  private rename(bound: Bound): void {
    const originals = this.paths('Rename-Item', bound, true);
    const newName = bound.values.get('NewName')?.[0];
    if (!newName) return;
    const text = this.scan.text(newName);
    if (!this.hasPath('Rename-Item', bound)) {
      this.scan.write('Rename-Item', text, { path: null, why: 'input' }, false, false);
      return;
    }
    for (const original of originals) {
      const parent: Cwd = { dir: original.path === null ? null : win32.dirname(original.path), form: null, text: '' };
      const target = original.path === null ? original : this.scan.resolve(newName, parent, 'powershell', false);
      if (target) this.scan.write('Rename-Item', text, target, false, false);
    }
  }

  // ---- 参数 ----

  /** @brief 命令的参数，到语句或管道一节的末尾；其中的重定向就地记下。 */
  private args(): PsArg[] {
    const out: PsArg[] = [];
    for (;;) {
      this.spaces();
      if (this.atEnd()) return out;
      if (this.redirect()) continue;
      const before = this.i;
      const arg = this.arg();
      if (arg) out.push(arg);
      if (this.i === before) this.i += 1;
    }
  }

  /** @brief 一个参数：--% 解析失败；-名字 是参数名；@名字 是 splatting；其余是值（可以是逗号数组）。 */
  private arg(): PsArg | null {
    const s = this.s;
    const c = s[this.i];
    if (s.startsWith('--%', this.i) && (this.i + 3 >= s.length || isAt(s, this.i + 3, WORD_END))) {
      this.scan.fail('stop-parsing token');
    }
    if (c === '-' && /[A-Za-z_?]/.test(s[this.i + 1] ?? '')) return this.param();
    if (c === '@' && /[A-Za-z_?]/.test(s[this.i + 1] ?? '')) {
      const start = this.i;
      this.i += 1;
      while (this.i < s.length && !isAt(s, this.i, WORD_END)) this.i += 1;
      return { k: 'splat', raw: s.slice(start, this.i) };
    }
    const items = this.values();
    if (items.length === 0) return null;
    const only = items.length === 1 && items[0].pieces.length === 1 ? items[0].pieces[0] : null;
    return { k: 'value', items, end: only !== null && only.literal && !only.quoted && only.text === '--' };
  }

  /** @brief -名字 或 -名字:值。 */
  private param(): PsArg {
    const s = this.s;
    const start = this.i;
    this.i += 1;
    while (this.i < s.length && !isAt(s, this.i, WORD_END) && s[this.i] !== ':') this.i += 1;
    const name = s.slice(start + 1, this.i);
    if (s[this.i] !== ':') return { k: 'param', name, value: null };
    this.i += 1;
    this.spaces();
    return { k: 'param', name, value: this.values() };
  }

  /** @brief 一个值或逗号数组（逗号前后可以有空白）。 */
  private values(): Arg[] {
    const items: Arg[] = [];
    for (;;) {
      const item = this.value();
      if (item.pieces.length > 0) items.push(item);
      const save = this.i;
      this.spaces();
      if (this.s[this.i] !== ',') {
        this.i = save;
        return items;
      }
      this.i += 1;
      this.lines();
    }
  }

  /** @brief 一个值：( )、{ }、@( )、@{ } 是子表达式（看不出来，里面照样分析）；here-string；其余是词。 */
  private value(): Arg {
    const s = this.s;
    const c = s[this.i];
    const next = s[this.i + 1];
    const start = this.i;
    if (c === '(' || (c === '@' && next === '(')) this.paren(')', c === '(' ? 1 : 2, 'unclosed bracket');
    else if (c === '{') this.block();
    else if (c === '@' && next === '{') this.hashtable();
    else if (c === '@' && (next === "'" || next === '"')) return this.hereString();
    else return this.word();
    return this.scan.unknown(s.slice(start, this.i), 'substitution');
  }

  /** @brief 参数模式的一个词：字面字符、引号串、变量与子表达式、` 转义，到空白或操作符为止。 */
  private word(): Arg {
    const s = this.s;
    const pieces: Piece[] = [];
    while (this.i < s.length) {
      const code = s.charCodeAt(this.i);
      if (codeIs(code, WORD_END)) break;
      const c = s[this.i];
      if (!codeIs(code, WORD_STOP)) {
        const begin = this.i;
        this.i += 1;
        while (this.i < s.length && !isAt(s, this.i, WORD_END | WORD_STOP)) this.i += 1;
        const text = s.slice(begin, this.i);
        pieces.push({ text, value: text, why: null, quoted: false, literal: true });
      } else if (SQ.has(c)) pieces.push(this.single());
      else if (DQ.has(c)) this.double(pieces, null);
      else if (c === '$') pieces.push(this.variable(true));
      else {
        if (s[this.i + 1] === '\n' || (s[this.i + 1] === '\r' && s[this.i + 2] === '\n')) break;
        this.escape(pieces);
      }
    }
    return { pieces };
  }

  /** @brief ` 转义：`n 这类换成字符，`u{…} 换成码位，其余是它本身。 */
  private escape(pieces: Piece[]): void {
    const s = this.s;
    const next = s[this.i + 1];
    if (next === undefined) {
      this.i += 1;
      return;
    }
    const unicode = /u\{([0-9A-Fa-f]{1,6})\}/y;
    unicode.lastIndex = this.i + 1;
    const found = unicode.exec(s);
    if (found && parseInt(found[1], 16) <= 0x10ffff) {
      pieces.push(quoted(String.fromCodePoint(parseInt(found[1], 16))));
      this.i = unicode.lastIndex;
      return;
    }
    pieces.push(quoted(Object.hasOwn(ESCAPES, next) ? ESCAPES[next] : next));
    this.i += 2;
  }

  /** @brief '…'：原样，两个单引号是一个（弯引号同样）。 */
  private single(): Piece {
    const s = this.s;
    let text = '';
    this.i += 1;
    for (;;) {
      const c = s[this.i];
      if (c === undefined) this.scan.fail('unclosed quote');
      if (SQ.has(c)) {
        if (!SQ.has(s[this.i + 1] ?? '')) {
          this.i += 1;
          return quoted(text);
        }
        text += c;
        this.i += 2;
        continue;
      }
      const begin = this.i;
      while (this.i < s.length && !SQ.has(s[this.i])) this.i += 1;
      text += s.slice(begin, this.i);
    }
  }

  /**
   * @brief "…" 或 @"…"@ 的正文：` 转义，两个双引号是一个，$名字、${…}、$(…) 展开。
   * @param pieces 收集的段
   * @param bound here-string 正文的结束位置；双引号串为 null（到下一个单独的双引号）
   */
  private double(pieces: Piece[], bound: number | null): void {
    const s = this.s;
    if (bound === null) this.i += 1;
    for (;;) {
      if (bound !== null && this.i >= bound) return;
      const c = s[this.i];
      if (c === undefined) this.scan.fail('unclosed quote');
      if (bound === null && DQ.has(c)) {
        this.i += 1;
        if (!DQ.has(s[this.i] ?? '')) return;
        pieces.push(quoted(c));
        this.i += 1;
      } else if (c === '`') this.escape(pieces);
      else if (c === '$') pieces.push(this.variable(false));
      else {
        const begin = this.i;
        const end = bound ?? s.length;
        while (this.i < end && s[this.i] !== '`' && s[this.i] !== '$' && (bound !== null || !DQ.has(s[this.i]))) {
          this.i += 1;
        }
        pieces.push(quoted(s.slice(begin, this.i)));
      }
    }
  }

  /** @brief @'…'@ / @"…"@：开头的 @' 之后换行，结束的 '@ 在一行开头；没有闭合时失败。 */
  private hereString(): Arg {
    const s = this.s;
    const double = s[this.i + 1] === '"';
    let open = this.i + 2;
    while (s[open] === ' ' || s[open] === '\t' || s[open] === '\r') open += 1;
    if (s[open] !== '\n') return this.word();
    open += 1;
    const mark = double ? '"@' : "'@";
    const found = s.startsWith(mark, open) ? open : s.indexOf(`\n${mark}`, open) + 1;
    if (found <= 0) this.scan.fail('unclosed quote');
    let end = Math.max(open, found - 1);
    if (end > open && s[end - 1] === '\r') end -= 1;
    const pieces: Piece[] = [];
    if (double) {
      this.i = open;
      this.double(pieces, end);
    } else pieces.push(quoted(s.slice(open, end)));
    this.i = found + 2;
    return { pieces };
  }

  /**
   * @brief $ 开头的：$(…) 子表达式、${…}、$名字（可以带作用域，如 $env:TEMP）；参数里变量之后的 .属性、[下标] 看不出来。
   * @param inArg 在参数或表达式里（不在双引号里）
   */
  private variable(inArg: boolean): Piece {
    const s = this.s;
    const start = this.i;
    const next = s[this.i + 1];
    if (next === '(') {
      this.paren(')', 2, 'unclosed command substitution');
      return { text: s.slice(start, this.i), value: null, why: 'substitution', quoted: !inArg, literal: false };
    }
    let name: string;
    if (next === '{') {
      const end = s.indexOf('}', this.i + 2);
      if (end < 0) this.scan.fail('unclosed bracket');
      name = s.slice(this.i + 2, end);
      this.i = end + 1;
    } else {
      VAR_NAME.lastIndex = this.i + 1;
      const found = VAR_NAME.exec(s);
      if (!found) {
        this.i += 1;
        return { text: '$', value: '$', why: null, quoted: !inArg, literal: true };
      }
      name = found[0];
      this.i = VAR_NAME.lastIndex;
    }
    const piece = this.scan.varPiece(name, s.slice(start, this.i), 'powershell', this.run.cwd, !inArg);
    if (!inArg || !this.member()) return piece;
    return { text: s.slice(start, this.i), value: null, why: 'variable', quoted: false, literal: false };
  }

  /** @brief 变量之后的 .属性、.方法(…)、[下标]：吃掉它们并返回真。 */
  private member(): boolean {
    const s = this.s;
    let found = false;
    for (;;) {
      if (s[this.i] === '.' && /[A-Za-z_]/.test(s[this.i + 1] ?? '')) {
        this.i += 1;
        while (/[A-Za-z0-9_]/.test(s[this.i] ?? '')) this.i += 1;
        if (s[this.i] === '(') this.paren(')', 1, 'unclosed bracket');
      } else if (s[this.i] === '[') this.bracket();
      else return found;
      found = true;
    }
  }

  // ---- 重定向（§7.5） ----

  /** @brief > >> n> n>> *> *>> 记写入（目标 $null 不算）；n>&1 这类合并不是写入；< 解析失败。是重定向时返回真。 */
  private redirect(): boolean {
    const s = this.s;
    let j = this.i;
    let fd = '';
    if (s[j] !== '>' && s[j] !== '<' && s[j + 1] !== '>') return false;
    if (/[1-6*]/.test(s[j] ?? '') && s[j + 1] === '>') {
      fd = s[j];
      j += 1;
    }
    if (fd === '' && s[j] === '<') this.scan.fail('PowerShell has no < redirection');
    if (s[j] !== '>') return false;
    let op = '>';
    j += 1;
    if (s[j] === '>') {
      op = '>>';
      j += 1;
    }
    if (s[j] === '&' && /[12]/.test(s[j + 1] ?? '')) {
      this.i = j + 2;
      return true;
    }
    this.i = j;
    this.spaces();
    const target = this.value();
    if (this.scan.text(target).toLowerCase() === '$null') return true;
    const resolved = this.scan.resolve(target, this.run.cwd, 'powershell', false);
    if (!resolved) return true;
    if (this.pendingLevel === this.level) {
      (this.pending ??= []).push({ form: fd + op, text: this.scan.text(target), target: resolved });
    } else this.scan.write(fd + op, this.scan.text(target), resolved, false, false);
    return true;
  }
}

// ---- 只读命令里的 .NET 调用（§7.7 末尾第 4 条） ----

/** @brief 成员名里的名字：字母、数字、_（不限 ASCII；sticky）。 */
const MEMBER_NAME = /[\p{L}\p{N}_]+/uy;
/** @brief $ 之后的变量名（可以带作用域，不限 ASCII；sticky）。 */
const MEMBER_VARIABLE = /[\p{L}\p{N}_?:]+|[$^]/uy;
/** @brief 成员名之后的赋值操作符（可以隔空格；PowerShell 把长短横线也当 -；sticky）。 */
const MEMBER_ASSIGN = /[ \t]*(?:[-+*/%–—―]|\?\?)?=(?!=)/y;
/**
 * @brief 类型字面量 [名字] 或带泛型参数的 [名字[…]]（泛型参数里的空白只认逗号之后的；最多 256 段，扫描的时间有上限；
 *        sticky，从 [ 起）。
 */
const TYPE_LITERAL = /\[[\p{L}_][\p{L}\p{N}_.`]*(?:\[(?:[\p{L}\p{N}_.`[\]]|,[ \t]*){0,256}\])?\]/uy;
/** @brief [ 跟在这些字符后面时是下标或泛型参数，不是类型字面量的开头。 */
const BEFORE_INDEX = /[\p{L}\p{N}_.`[]/u;
/** @brief -as 操作符（不分大小写，长短横线同 -）：把值转换成类型，会调构造函数。 */
const AS_OPERATOR = /[-–—―]as(?![\p{L}\p{N}_])/iu;
/** @brief 类型转换里值的第一个字符：引号、$、(、@、[、数字。 */
const CAST_VALUE = /^['"‘’‚‛“”„$(@[0-9]/;
/** @brief 找成员名的结尾时最多进几层括号与引号（同 SCAN_MAX_DEPTH）；更深时按调用算。 */
const NET_DEPTH = 32;
/** @brief NetCalls.memberEnd 的结果：不是成员名。 */
const NOT_MEMBER = -1;
/** @brief NetCalls.memberEnd 的结果：括号太深，按调用算。 */
const TOO_DEEP = -2;
/** @brief 括号对应的右括号。 */
const CLOSERS: Readonly<Record<string, string>> = { '(': ')', '{': '}', '[': ']' };

/**
 * @brief 文字里的 .NET 调用（§7.7 末尾第 4 条）：成员的调用与赋值、类型转换、-as（转换会调构造函数）。只看文字，引号里的
 *        也算，宁可多拒绝；每个位置最多被 NET_DEPTH 层括号各扫一遍，时间与文字长度成正比。
 */
class NetCalls {
  constructor(private readonly s: string) {}

  /**
   * @brief 有没有：. 或 :: 之后（可以隔空白、换行、续行）是成员名，之后紧跟 ( 或 {（调用），或隔空格跟赋值操作符；
   *        类型字面量之后（可以隔空白）跟着一个值（类型转换）；-as。. 前面是空白或在开头时不是成员访问（点源、路径）。
   */
  found(): boolean {
    const s = this.s;
    if (AS_OPERATOR.test(s)) return true;
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i];
      if (c === '.' && i > 0 && !/\s/.test(s[i - 1]) && this.memberUse(i + 1)) return true;
      if (c === ':' && s[i + 1] === ':' && this.memberUse(i + 2)) return true;
      if (c === '[' && !BEFORE_INDEX.test(s[i - 1] ?? '') && this.cast(i)) return true;
    }
    return false;
  }

  /** @brief 从 start（. 或 :: 之后）起是成员的调用或赋值；成员名之前有注释时按调用算。 */
  private memberUse(start: number): boolean {
    const at = this.gap(start);
    if (this.comment(at)) return true;
    const end = this.memberEnd(at, 0);
    if (end === TOO_DEEP) return true;
    if (end === NOT_MEMBER) return false;
    if (this.s[end] === '(' || this.s[end] === '{') return true;
    MEMBER_ASSIGN.lastIndex = end;
    return MEMBER_ASSIGN.test(this.s);
  }

  /** @brief 从 at（[）起是类型字面量，之后（可以隔空白；有注释时也算）跟着一个值：类型转换。 */
  private cast(at: number): boolean {
    TYPE_LITERAL.lastIndex = at;
    if (!TYPE_LITERAL.test(this.s)) return false;
    const next = this.gap(TYPE_LITERAL.lastIndex);
    return this.comment(next) || CAST_VALUE.test(this.s[next] ?? '');
  }

  /** @brief 从 k 起跳过空白、换行与续行（` 加空白），返回之后的位置。 */
  private gap(k: number): number {
    const s = this.s;
    for (;;) {
      if (/\s/.test(s[k] ?? '')) k += 1;
      else if (s[k] === '`' && /\s/.test(s[k + 1] ?? '')) k += 2;
      else return k;
    }
  }

  /** @brief 位置 k 是注释的开头（# 或 <#）。 */
  private comment(k: number): boolean {
    return this.s[k] === '#' || (this.s[k] === '<' && this.s[k + 1] === '#');
  }

  /**
   * @brief 从 j 起的成员名的结尾：名字（可以带泛型的 [ … ]）、引号里的字符串、$变量、${…}、$( … )、( … )、@( … )、{ … }。
   * @return 结尾之后的位置；不是成员名时为 NOT_MEMBER，括号太深时为 TOO_DEEP
   */
  private memberEnd(j: number, depth: number): number {
    const s = this.s;
    const c = s[j];
    if (c === undefined) return NOT_MEMBER;
    if (c === '$') {
      if (s[j + 1] === '(' || s[j + 1] === '{') return this.groupEnd(j + 1, depth);
      MEMBER_VARIABLE.lastIndex = j + 1;
      return MEMBER_VARIABLE.test(s) ? MEMBER_VARIABLE.lastIndex : j + 1;
    }
    if (c === '(' || c === '{') return this.groupEnd(j, depth);
    if (c === '@' && (s[j + 1] === '(' || s[j + 1] === '{')) return this.groupEnd(j + 1, depth);
    if (SQ.has(c) || DQ.has(c)) return this.quoteEnd(j, depth);
    MEMBER_NAME.lastIndex = j;
    if (!MEMBER_NAME.test(s)) return NOT_MEMBER;
    const end = MEMBER_NAME.lastIndex;
    return s[end] === '[' ? this.groupEnd(end, depth) : end;
  }

  /** @brief 从 j（( { [ 之一）起到对应的右括号之后；里面的括号、引号、` 照样跳过；没有右括号时为文字末尾。 */
  private groupEnd(j: number, depth: number): number {
    if (depth >= NET_DEPTH) return TOO_DEEP;
    const s = this.s;
    const close = CLOSERS[s[j]];
    let k = j + 1;
    while (k < s.length && s[k] !== close) {
      const c = s[k];
      let next = k + 1;
      if (c === '`') next = k + 2;
      else if (c === '(' || c === '{' || c === '[') next = this.groupEnd(k, depth + 1);
      else if (SQ.has(c) || DQ.has(c)) next = this.quoteEnd(k, depth + 1);
      if (next === TOO_DEEP) return TOO_DEEP;
      k = next;
    }
    return Math.min(k + 1, s.length);
  }

  /** @brief 从 j（引号）起到配对的引号之后（两个引号连写是一个引号；双引号里 ` 转义，$( … ) 照样跳过）。 */
  private quoteEnd(j: number, depth: number): number {
    const s = this.s;
    const single = SQ.has(s[j]);
    const quotes = single ? SQ : DQ;
    let k = j + 1;
    while (k < s.length) {
      const c = s[k];
      if (quotes.has(c)) {
        if (!quotes.has(s[k + 1] ?? '')) return k + 1;
        k += 2;
      } else if (!single && c === '`') k += 2;
      else if (!single && c === '$' && s[k + 1] === '(') {
        k = this.groupEnd(k + 1, depth + 1);
        if (k === TOO_DEEP) return TOO_DEEP;
      } else k += 1;
    }
    return s.length;
  }
}

// ---- 入口 ----

/**
 * @brief 按 PowerShell 的语法分析一段文字（整条命令、Invoke-Expression 的文字，或经 Scan.nested 的嵌套文字），结果记在 scan 上。
 * @param scan 这次分析的状态
 * @param text 文字
 * @param run 执行状态（当前目录、Push-Location 的栈、定义过的函数）；Invoke-Expression 与外面共用
 * @param level 这段文字所在的嵌套层数
 */
export function scanPsText(scan: Scan, text: string, run: Run, level: number): void {
  new Reader(scan, text, run, level).script();
  // 只看文字：引号里的同样算，宁可多拒绝（§7.7 末尾第 4 条）；已经不是只读命令时不必再找
  if (scan.onlyReads && new NetCalls(text).found()) scan.notReadOnly();
}
