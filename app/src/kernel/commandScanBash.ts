// Git Bash 的命令分析（docs/specs/file-system-permissions.md §7.3–§7.7）：先切成词和操作符、拼成命令列表与复合结构，
// 再按执行顺序逐条处理简单命令（前缀与包装、认得出的写法、换目录、只读名单）。
// 只被 commandScan.ts 调用，只以类型引用它；变量的值、路径解析、当前目录的几种可能、GNU 选项的分法、git、嵌套 shell
// 与结果都在 Scan 上。

import type { Arg, Chain, Cwd, GitEnv, GitName, Gnu, Run, Scan, State, Stdin, Target, UnknownWhy } from './commandScan';

// ---- 语法树 ----

/**
 * @brief 词的一段（解析时）：k 为 lit（字面 s）、var（变量 name，原文 raw）或 sub（替换，原文 raw，原因 why，
 *        要分析的命令 lists，proc 为 <(…) / >(…)）；q 为在引号里或经过转义。三种都带全部字段（用不到的为空），
 *        对象形状一致，1 MB 的命令里成千上万次访问保持快。
 */
interface Part {
  k: 'lit' | 'var' | 'sub';
  s: string;
  name: string;
  raw: string;
  why: UnknownWhy | null;
  lists: List[];
  q: boolean;
  proc: boolean;
}

/** @brief 一个词。 */
interface Word {
  parts: Part[];
}

/** @brief here-doc：正文在命令那一行之后读入（§7.3）。 */
interface Doc {
  /** 结束词（去掉引号） */
  delim: string;
  /** 结束词里有引号：正文原样，不展开 */
  quoted: boolean;
  /** <<-：先去掉每行开头的 tab */
  strip: boolean;
  /** 正文 */
  body: string;
  /** 没有引号时正文解析成的词（其中的 $(…)、`…` 照样分析）；有引号时为 null */
  parts: Word | null;
}

/** @brief 重定向。kind：write 是写入；read 不是写入（<、<&、复制或关闭 fd）；doc 是 here-doc；string 是 here-string。 */
interface Redir {
  form: string;
  kind: 'write' | 'read' | 'doc' | 'string';
  target: Word | null;
  doc: Doc | null;
}

/** @brief 简单命令的一项，按出现顺序：词、开头的赋值（array 为 名字=(…) 的词表）、重定向。 */
type Item =
  | { k: 'word'; w: Word }
  | { k: 'assign'; name: string; value: Word; array: Word[] | null; arrayText: string }
  | { k: 'redir'; r: Redir };

/** @brief 简单命令；level 为它所在的嵌套层数（嵌套 shell 从这里再加一层）。 */
interface Simple {
  k: 'simple';
  items: Item[];
  level: number;
  /** 有开头的赋值 */
  assigns: boolean;
}

/** @brief case 的一支：模式与列表；fall 为以 ;& 或 ;;& 结束（下一支可能接着跑）。 */
interface Arm {
  words: Word[];
  body: List;
  fall: boolean;
}

/**
 * @brief 复合结构。flow 为 seq 时 seq 按出现顺序走一遍；if 时 seq 为 条件、主体、（elif 的条件、主体）…、（else 的主体）；
 *        loop 时 seq 的前 once 项只算一次（for 的词表），其余（条件与主体）每一轮都跑；case 时 seq 为 case 的词，各支在 arms。
 *        sub 为子 shell；loopVar 为 for / select 的名字。
 */
interface Compound {
  k: 'compound';
  flow: 'seq' | 'if' | 'loop' | 'case';
  sub: boolean;
  seq: (List | Word)[];
  once: number;
  arms: Arm[];
  loopVar: string | null;
  redirs: Redir[];
}

type Cmd = Simple | Compound;

/** @brief 管道；or 为它前面是 ||（列表的第一个管道与 && 之后的为假）。 */
interface Pipeline {
  cmds: Cmd[];
  or: boolean;
}

/** @brief 用 && / || 连起来的管道；bg 为以 & 放到后台。 */
interface AndOr {
  pipes: Pipeline[];
  bg: boolean;
}

/** @brief 命令列表。 */
interface List {
  items: AndOr[];
}

/**
 * @brief 顶层边读边处理（Parser.stream）：一项开始、一个管道开始（or 为它前面是 ||）、一条命令（piped 为从管道读，
 *        isolated 为在子 shell 里）、一项结束。
 */
interface Sink {
  begin(): void;
  pipe(or: boolean): void;
  top(cmd: Cmd, piped: boolean, isolated: boolean): void;
  end(bg: boolean): void;
}

/** @brief 顶层交给 Sink 的一个事件（等 here-doc 正文时排队用）；flag：pipe 为前面是 ||，top 为在子 shell 里，end 为放到后台。 */
interface Event {
  kind: 'begin' | 'pipe' | 'top' | 'end';
  cmd: Cmd | null;
  piped: boolean;
  flag: boolean;
}

/** @brief 把一个事件交给 sink。 */
function deliver(sink: Sink, kind: Event['kind'], cmd: Cmd | null, piped: boolean, flag: boolean): void {
  if (kind === 'begin') sink.begin();
  else if (kind === 'pipe') sink.pipe(flag);
  else if (kind === 'end') sink.end(flag);
  else if (cmd) sink.top(cmd, piped, flag);
}

/** @brief 列表在哪里结束：words 为结束的保留字；paren 为遇到 ) 结束；arm 为 case 的一支（遇到 ;; ;& ;;& 结束）。 */
interface Stop {
  words: ReadonlySet<string>;
  paren: boolean;
  arm: boolean;
}

// ---- 常量 ----

/** @brief 字符的类别（按字符码查 CLASS）：引号外结束一个词的、词里要另外处理的、双引号里与 here-doc 正文里要另外处理的。 */
const META = 1;
const SPECIAL = 2;
const DOUBLE_STOP = 4;
const DOC_STOP = 8;
/** @brief 保留字的第一个字符（不是它们时不必取出词来比较）。 */
const RESERVED_START = 16;
/** @brief 重定向可以从它开始：fd 数字、{名字}、< > &（简单命令里只在这些字符上试重定向）。 */
const REDIR_START = 32;
/** @brief ASCII 字符的类别位；其余字符都是普通字符。 */
const CLASS = new Uint8Array(128);
for (const c of ' \t\r\n;&|()<>') CLASS[c.charCodeAt(0)] |= META;
for (const c of '\'"\\$`') CLASS[c.charCodeAt(0)] |= SPECIAL;
for (const c of '"\\$`') CLASS[c.charCodeAt(0)] |= DOUBLE_STOP;
for (const c of '\\$`') CLASS[c.charCodeAt(0)] |= DOC_STOP;
for (const c of 'itefdwusc{}![]') CLASS[c.charCodeAt(0)] |= RESERVED_START;
for (const c of '0123456789{<>&') CLASS[c.charCodeAt(0)] |= REDIR_START;
/** @brief 开头的 名字=值、名字+=值、名字[下标]=值（§7.4）。 */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/;
/** @brief 最长的保留字（function）的长度。 */
const RESERVED_MAX = 8;
/** @brief 保留字（只在命令的位置算，区分大小写，§7.3）。 */
const RESERVED: ReadonlySet<string> = new Set([
  'if', 'then', 'elif', 'else', 'fi', 'do', 'done', 'while', 'until', 'for', 'select', 'case', 'esac', 'in',
  'function', '{', '}', '!', 'time', '[[', ']]', 'coproc',
]);
/** @brief 结束结构的保留字：不在当前列表的结束词里时（多出来的）跳过。 */
const CLOSERS: ReadonlySet<string> = new Set(['then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}']);
const NO_WORDS: ReadonlySet<string> = new Set();
const THEN: ReadonlySet<string> = new Set(['then']);
const ELSE_FI: ReadonlySet<string> = new Set(['elif', 'else', 'fi']);
const DO: ReadonlySet<string> = new Set(['do']);
const DONE: ReadonlySet<string> = new Set(['done']);
const ESAC: ReadonlySet<string> = new Set(['esac']);
const BRACE: ReadonlySet<string> = new Set(['}']);
const TOP: Stop = { words: NO_WORDS, paren: false, arm: false };
const PAREN: Stop = { words: NO_WORDS, paren: true, arm: false };
/** @brief ANSI-C 引号 $'…' 的单字符转义。 */
const ANSI: Readonly<Record<string, string>> = {
  n: '\n', t: '\t', r: '\r', a: '\u0007', b: '\b', e: '\u001b', E: '\u001b', f: '\f', v: '\v', '\\': '\\', "'": "'",
  '"': '"', '?': '?',
};
/** @brief 命令改过之后看不出来的四个变量。 */
const WORK_NAMES: ReadonlySet<string> = new Set(['TEMP', 'TMP', 'TMPDIR', 'PWD']);
/** @brief env -i 清掉的变量里要看的：四个变量（看不出来），PATH（不是只读命令，§7.7 末尾第 6 条）。 */
const CLEARED: readonly string[] = [...WORK_NAMES, 'PATH'];
/** @brief git 认的两个环境变量。 */
const GIT_NAMES: ReadonlySet<string> = new Set(['GIT_DIR', 'GIT_WORK_TREE']);
/** @brief 设变量的内建命令（带 名字=值 时同“只有赋值”，§7.4）。 */
const DECLARERS: ReadonlySet<string> = new Set(['export', 'declare', 'local', 'readonly', 'typeset']);
/** @brief builtin、wrapper、nestedShell 处理的命令名（其余命令不必逐个比较）。 */
const SPECIAL_COMMANDS: ReadonlySet<string> = new Set([
  'cd', 'pushd', 'popd', 'dirs', 'export', 'declare', 'local', 'readonly', 'typeset', 'unset', 'read', 'git', 'env',
  'command',
  'builtin', 'nohup', 'time', 'exec', 'nice', 'timeout', 'xargs', 'find', 'eval', 'trap', 'bash', 'sh', 'pwsh',
  'powershell',
]);
/** @brief find 里跑命令的写法（§7.4）。 */
const FIND_EXEC: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir']);
/** @brief find 写文件的写法：有它们时 find 不是只读（§7.7）。 */
const FIND_WRITES: ReadonlySet<string> = new Set(['-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);
const NO_STDIN: Stdin = { kind: 'none', text: '' };
/** @brief 前缀里没有 GIT_DIR / GIT_WORK_TREE。 */
const NO_ENV: GitEnv = {};
/** @brief 没有要分析的命令（字面与变量的 lists）。 */
const NO_LISTS: List[] = [];
const PIPED_STDIN: Stdin = { kind: 'unknown', text: '' };

/** @brief 简单命令执行时的环境：前缀里的 GIT_DIR / GIT_WORK_TREE、标准输入（含从管道读）、所在层数。 */
interface Ctx {
  env: GitEnv;
  stdin: Stdin;
  level: number;
}

/** @brief 一个已按当时的当前目录解析、还没记下的重定向写入。 */
interface QueuedWrite {
  form: string;
  text: string;
  target: Target;
}

/**
 * @brief 逐项处理一条简单命令时收集的东西。queued：命令名之后的重定向写入，命令本身的目标之后再记（§7.2 按文字里的顺序：
 *        rm a > log 先 rm 后 >）；docs：here-doc，正文在这一行之后，命令处理完再分析其中的替换。
 */
interface Box {
  args: Arg[];
  assigns: { name: string; value: Arg }[] | null;
  env: GitEnv;
  stdin: Stdin | null;
  queued: QueuedWrite[] | null;
  docs: Doc[] | null;
}


/** @brief 字符 c（可以是 undefined）属于类别 mask。 */
function is(c: string | undefined, mask: number): boolean {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  return code < 128 && (CLASS[code] & mask) !== 0;
}

/** @brief 文字 s 的第 at 个字符属于类别 mask；越界时不属于（逐字符扫描的循环用，不取出单个字符）。 */
function isAt(s: string, at: number, mask: number): boolean {
  const code = s.charCodeAt(at);
  return code < 128 && (CLASS[code] & mask) !== 0;
}

/** @brief 一段字面。 */
function litPart(s: string, q: boolean): Part {
  return { k: 'lit', s, name: '', raw: '', why: null, lists: NO_LISTS, q, proc: false };
}

/** @brief 一个变量引用。 */
function varPart(name: string, raw: string, q: boolean): Part {
  return { k: 'var', s: '', name, raw, why: null, lists: NO_LISTS, q, proc: false };
}

/** @brief 一个替换（命令替换、算术、复杂的 ${…}、进程替换）。 */
function subPart(raw: string, why: UnknownWhy, lists: List[], q: boolean, proc: boolean): Part {
  return { k: 'sub', s: '', name: '', raw, why, lists, q, proc };
}

/** @brief 命令名里有看不出来的部分（变量、替换、输入）。 */
function unknownName(name: Arg): boolean {
  for (const piece of name.pieces) if (piece.why !== null) return true;
  return false;
}

/** @brief 往词里加一段字面；与前一段引号状态相同时合并。 */
function pushLit(parts: Part[], s: string, q: boolean): void {
  if (s === '') return;
  const last = parts[parts.length - 1];
  if (last && last.k === 'lit' && last.q === q) last.s += s;
  else parts.push(litPart(s, q));
}

/** @brief here-doc 的结束词：去掉引号；有引号或转义时正文不展开。 */
function docDelim(word: Word): { delim: string; quoted: boolean } {
  let delim = '';
  let quoted = false;
  for (const part of word.parts) {
    if (part.k === 'lit') delim += part.s;
    else delim += part.raw;
    if (part.q) quoted = true;
  }
  return { delim, quoted };
}

/**
 * @brief 词是复制或关闭 fd 的目标（>&2、>&-、2>&1-、>&"2"）：每一段都是字面，连起来是数字或 -。有变量或替换的
 *        （>&$HOME/x、>& ../l"$n"）是文件（§7.5）。
 */
function isFdWord(word: Word | null): boolean {
  if (!word) return true;
  let text = '';
  for (const part of word.parts) {
    if (part.k !== 'lit') return false;
    text += part.s;
  }
  return /^(?:\d+-?|-)$/.test(text);
}

/** @brief 一个复合结构：seq 都只算一次（loop 另设 once）。 */
function compoundOf(flow: Compound['flow'], seq: (List | Word)[]): Compound {
  return { k: 'compound', flow, sub: false, seq, once: seq.length, arms: [], loopVar: null, redirs: [] };
}


// ---- 词法与语法 ----

/** @brief 把一段 bash 文字拼成语法树；引号与括号没有闭合时失败，缺结束词的结构到末尾自动结束（§7.3）。 */
class Parser {
  private i = 0;
  /** 等着在下一个换行之后读正文的 here-doc */
  private docs: Doc[] = [];
  /** 顶层读完的命令交给它（stream）；null 时顶层的项留在返回的列表里（parse） */
  private sink: Sink | null = null;
  /** 交给 sink 的事件；这一行还有 here-doc 正文没读时先留着，之后按顺序交 */
  private queue: Event[] = [];
  /** reserved() 上次看的位置与结果 */
  private reservedAt = -1;
  private reservedWord: string | null = null;

  constructor(private readonly scan: Scan, private readonly s: string, private level: number) {}

  /** @brief 整段文字，拼成一个列表（`…` 的内容用它）。 */
  parse(): List {
    return this.list(TOP);
  }

  /**
   * @brief 整段文字，顶层的每条命令一读完（且这一行的 here-doc 正文都读了）就交给 sink，语法树用完就丢，
   *        1 MB 的命令（含很长的管道与 && 链）也不必整棵留在内存里。
   */
  stream(sink: Sink): void {
    this.sink = sink;
    this.list(TOP);
    this.flush(sink);
  }

  /**
   * @brief 交给 sink 一个事件：没有等着读正文的 here-doc 时直接交（连同之前留下的），否则先留着。
   * @param kind 一项开始、一条命令、一项结束
   * @param cmd 命令（kind 为 top 时）
   * @param piped 从管道读标准输入
   * @param flag top 时为在子 shell 里；end 时为放到后台
   */
  private emit(kind: Event['kind'], cmd: Cmd | null, piped: boolean, flag: boolean): void {
    const sink = this.sink;
    if (!sink) return;
    if (this.docs.length > 0 || this.queue.length > 0) {
      this.queue.push({ kind, cmd, piped, flag });
      if (this.docs.length === 0) this.flush(sink);
    } else deliver(sink, kind, cmd, piped, flag);
  }

  /** @brief 按顺序交出留下的事件。 */
  private flush(sink: Sink): void {
    const queue = this.queue;
    this.queue = [];
    for (const event of queue) deliver(sink, event.kind, event.cmd, event.piped, event.flag);
  }

  /** @brief 顶层的一项（stream）：用 && / || 连起来的管道，每条命令读完就交给 sink；最后按是否放到后台结束这一项。 */
  private topItem(): void {
    this.emit('begin', null, false, false);
    let or = false;
    for (;;) {
      this.emit('pipe', null, false, or);
      this.topPipeline();
      this.blanks();
      or = this.s.startsWith('||', this.i);
      if (!or && !this.s.startsWith('&&', this.i)) break;
      this.i += 2;
      this.lines();
    }
    this.emit('end', null, false, this.separator());
  }

  /** @brief 顶层的一个管道（stream）：多于一节时每一节在子 shell 里，第二节起从管道读标准输入。 */
  private topPipeline(): void {
    this.prefixes();
    for (let index = 0; ; index += 1) {
      const cmd = this.command(TOP);
      if (!cmd) return;
      this.blanks();
      const bar = this.bar();
      this.emit('top', cmd, index > 0, bar || index > 0);
      if (!bar) return;
      this.lines();
    }
  }

  /** @brief 管道符 | 或 |&：吃掉它并返回真。 */
  private bar(): boolean {
    const s = this.s;
    if (s.startsWith('|&', this.i)) this.i += 2;
    else if (s[this.i] === '|' && s[this.i + 1] !== '|') this.i += 1;
    else return false;
    return true;
  }

  /** @brief here-doc 的正文（没有引号的）：$(…)、`…`、${…} 照样展开，\ 只转义 $ ` \ 和换行。 */
  docWord(): Word {
    const parts: Part[] = [];
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '$') this.dollar(parts, true);
      else if (c === '`') this.backtick(parts, true);
      else if (c === '\\') this.docEscape(parts);
      else this.run(parts, true, DOC_STOP);
    }
    return { parts };
  }

  private enter(): void {
    this.level = this.scan.deeper(this.level);
  }

  private leave(): void {
    this.level -= 1;
  }

  // ---- 空白、注释、换行 ----

  /** @brief 跳过空格、tab、\r（当空白，§7.3）与续行。 */
  private blanks(): void {
    const s = this.s;
    for (;;) {
      const code = s.charCodeAt(this.i);
      if (code === 32 || code === 9 || code === 13) this.i += 1;
      else if (code !== 92) return;
      else if (s[this.i + 1] === '\n') this.i += 2;
      else if (s[this.i + 1] === '\r' && s[this.i + 2] === '\n') this.i += 3;
      else return;
    }
  }

  /** @brief 跳过空白与词首的注释（到行尾，不含换行）。 */
  private gap(): void {
    this.blanks();
    if (this.s[this.i] !== '#') return;
    const end = this.s.indexOf('\n', this.i);
    this.i = end < 0 ? this.s.length : end;
  }

  /** @brief 跳过空白、注释与换行。 */
  private lines(): void {
    for (;;) {
      this.gap();
      if (this.s[this.i] !== '\n') return;
      this.newline();
    }
  }

  /** @brief 吃掉一个换行，再依次读这一行的 here-doc 正文。 */
  private newline(): void {
    this.i += 1;
    if (this.docs.length === 0) return;
    const docs = this.docs;
    this.docs = [];
    for (const doc of docs) this.docBody(doc);
  }

  /** @brief 读一个 here-doc 的正文：到只有结束词的一行为止；没有结束行时到文字末尾（§7.3）。 */
  private docBody(doc: Doc): void {
    const s = this.s;
    const lines: string[] = [];
    while (this.i < s.length) {
      const found = s.indexOf('\n', this.i);
      const end = found < 0 ? s.length : found;
      let line = s.slice(this.i, end);
      this.i = found < 0 ? end : end + 1;
      if (doc.strip) line = line.replace(/^\t+/, '');
      if (line.replace(/\r$/, '') === doc.delim) break;
      lines.push(line);
    }
    doc.body = lines.join('\n');
    if (!doc.quoted) doc.parts = new Parser(this.scan, doc.body, this.level).docWord();
  }

  /** @brief 命令位置上的保留字（不消耗）；不是时为 null。 */
  private reserved(): string | null {
    if (this.reservedAt === this.i) return this.reservedWord;
    const s = this.s;
    this.reservedAt = this.i;
    this.reservedWord = null;
    if (!isAt(s, this.i, RESERVED_START)) return null;
    let j = this.i;
    const limit = Math.min(s.length, this.i + RESERVED_MAX + 1);
    while (j < limit && !isAt(s, j, META | SPECIAL)) j += 1;
    let word: string | null = null;
    if (j > this.i && j - this.i <= RESERVED_MAX && !isAt(s, j, SPECIAL)) word = s.slice(this.i, j);
    this.reservedWord = word !== null && RESERVED.has(word) ? word : null;
    return this.reservedWord;
  }

  // ---- 列表 ----

  /** @brief 命令列表：到 stop 指定的结束处或文字末尾。 */
  private list(stop: Stop): List {
    const items: AndOr[] = [];
    for (;;) {
      this.lines();
      const before = this.i;
      if (this.atListEnd(stop)) break;
      if (this.i !== before) continue;
      if (stop === TOP && this.sink) this.topItem();
      else {
        const item = this.andOr(stop);
        item.bg = this.separator();
        if (item.pipes.length > 0) items.push(item);
      }
      if (this.i === before) this.i += 1;
    }
    return { items };
  }

  /** @brief 列表到了结束处；多出来的分隔符、右括号与结束词吃掉后返回 false。 */
  private atListEnd(stop: Stop): boolean {
    const s = this.s;
    const c = s[this.i];
    if (c === undefined) return true;
    if (c === ')') {
      if (stop.paren) return true;
      this.i += 1;
      return false;
    }
    if (c === ';') {
      const arm = s[this.i + 1] === ';' || s[this.i + 1] === '&';
      if (arm && stop.arm) return true;
      this.i += arm ? (s.startsWith(';;&', this.i) ? 3 : 2) : 1;
      return false;
    }
    const word = this.reserved();
    if (word !== null && stop.words.has(word)) return true;
    if (word !== null && CLOSERS.has(word)) this.i += word.length;
    return false;
  }

  /**
   * @brief 列表项之后的分隔符：; 、& （放到后台）、换行。
   * @return 以 & 放到后台
   */
  private separator(): boolean {
    this.gap();
    const s = this.s;
    const c = s[this.i];
    const next = s[this.i + 1];
    if (c === ';' && next !== ';' && next !== '&') this.i += 1;
    else if (c === '&' && next !== '&' && next !== '>') {
      this.i += 1;
      return true;
    } else if (c === '\n') this.newline();
    return false;
  }

  /** @brief 用 && / || 连起来的管道。 */
  private andOr(stop: Stop): AndOr {
    const pipes: Pipeline[] = [];
    let or = false;
    for (;;) {
      const pipe = this.pipeline(stop, or);
      if (pipe.cmds.length > 0) pipes.push(pipe);
      this.blanks();
      or = this.s.startsWith('||', this.i);
      if (!or && !this.s.startsWith('&&', this.i)) break;
      this.i += 2;
      this.lines();
    }
    return { pipes, bg: false };
  }

  /** @brief 管道：| 与 |& 连接；前面的 ! 与 time [-p] 跳过；or 为它前面是 ||。 */
  private pipeline(stop: Stop, or: boolean): Pipeline {
    this.prefixes();
    const cmds: Cmd[] = [];
    for (;;) {
      const cmd = this.command(stop);
      if (!cmd) break;
      cmds.push(cmd);
      this.blanks();
      if (!this.bar()) break;
      this.lines();
    }
    return { cmds, or };
  }

  /** @brief 管道前的 ! 与 time [-p]。 */
  private prefixes(): void {
    for (;;) {
      this.blanks();
      const word = this.reserved();
      if (word === '!') this.i += 1;
      else if (word === 'time') {
        this.i += 4;
        this.blanks();
        if (/^-p(?:[\s;&|]|$)/.test(this.s.slice(this.i, this.i + 3))) this.i += 2;
      } else return;
    }
  }

  // ---- 命令 ----

  /** @brief 一条命令：复合结构、子 shell、(( … ))、函数定义或简单命令；到了分隔符或结束词时为 null。 */
  private command(stop: Stop): Cmd | null {
    this.blanks();
    const s = this.s;
    const c = s[this.i];
    if (c === undefined || c === '\n' || c === ';' || c === '&' || c === '|' || c === ')') return null;
    const word = this.reserved();
    if (word !== null && (stop.words.has(word) || CLOSERS.has(word))) return null;
    const compound = word === null ? null : this.compound(word, stop);
    if (compound) return compound;
    if (s.startsWith('((', this.i)) return this.trailing(this.arith());
    if (c === '(') return this.subshell();
    return this.simple(stop);
  }

  /** @brief 保留字开头的复合结构；不是时为 null。 */
  private compound(word: string, stop: Stop): Cmd | null {
    switch (word) {
      case 'if': return this.trailing(this.ifCmd(stop));
      case 'while': case 'until': return this.trailing(this.whileCmd(word, stop));
      case 'for': case 'select': return this.trailing(this.forCmd(word, stop));
      case 'case': return this.trailing(this.caseCmd(stop));
      case '{': return this.trailing(this.group(stop));
      case '[[': return this.trailing(this.cond());
      case 'function': return this.functionCmd(stop);
      case 'coproc': return this.coproc(stop);
      default: return null;
    }
  }

  /** @brief coproc 命令：后面的命令照常分析（多一层嵌套，一长串 coproc 不会递归过深）。 */
  private coproc(stop: Stop): Cmd | null {
    this.i += 6;
    this.enter();
    const cmd = this.command(stop);
    this.leave();
    return cmd;
  }

  /** @brief 内层列表的结束处：换成新的结束词，括号与 case 的一支照外层。 */
  private inner(words: ReadonlySet<string>, stop: Stop): Stop {
    return { words, paren: stop.paren, arm: stop.arm };
  }

  /** @brief 当前位置是这个保留字时吃掉它。 */
  private take(word: string): boolean {
    if (this.reserved() !== word) return false;
    this.i += word.length;
    return true;
  }

  /** @brief if / elif / else / fi：seq 为 条件、主体、（elif 的条件、主体）…、（else 的主体）。 */
  private ifCmd(stop: Stop): Compound {
    this.i += 2;
    this.enter();
    const seq: (List | Word)[] = [this.list(this.inner(THEN, stop))];
    for (;;) {
      if (this.take('then') || this.take('else')) seq.push(this.list(this.inner(ELSE_FI, stop)));
      else if (this.take('elif')) seq.push(this.list(this.inner(THEN, stop)));
      else {
        this.take('fi');
        break;
      }
    }
    this.leave();
    return compoundOf('if', seq);
  }

  /** @brief while / until … do … done：条件与主体每一轮都跑。 */
  private whileCmd(word: string, stop: Stop): Compound {
    this.i += word.length;
    this.enter();
    const seq: (List | Word)[] = [this.list(this.inner(DO, stop))];
    if (this.take('do')) seq.push(this.list(this.inner(DONE, stop)));
    this.take('done');
    this.leave();
    const cmd = compoundOf('loop', seq);
    cmd.once = 0;
    return cmd;
  }

  /** @brief for / select 名字 [in 词…] ; do … done（词表只算一次），或 for ((…))（算术与主体每一轮都跑）。 */
  private forCmd(word: string, stop: Stop): Compound {
    this.i += word.length;
    this.enter();
    this.blanks();
    const seq: (List | Word)[] = [];
    let loopVar: string | null = null;
    let once = 0;
    if (this.s.startsWith('((', this.i)) seq.push(...this.arith().seq);
    else {
      loopVar = docDelim(this.word()).delim;
      this.lines();
      if (this.take('in')) this.wordList(seq);
      once = seq.length;
    }
    this.blanks();
    if (this.s[this.i] === ';') this.i += 1;
    this.lines();
    seq.push(this.loopBody(stop));
    this.leave();
    const cmd = compoundOf('loop', seq);
    cmd.once = once;
    cmd.loopVar = loopVar;
    return cmd;
  }

  /** @brief for 的词表：到 ; 或换行。 */
  private wordList(seq: (List | Word)[]): void {
    for (;;) {
      this.gap();
      const c = this.s[this.i];
      if (c === undefined || c === '\n' || c === ';' || c === '&' || c === '|' || c === ')') return;
      this.wordInto(seq);
    }
  }

  /** @brief 读一个词放进 seq（空的不放）；一个字符都没读时跳过一个字符（没有词能从它开始）。 */
  private wordInto(seq: (List | Word)[]): void {
    const before = this.i;
    const word = this.word();
    if (word.parts.length > 0) seq.push(word);
    if (this.i === before) this.i += 1;
  }

  /** @brief 循环的主体：do … done 或 { … }；缺 do 时也读到 done。 */
  private loopBody(stop: Stop): List {
    if (this.take('{')) {
      const body = this.list(this.inner(BRACE, stop));
      this.take('}');
      return body;
    }
    this.take('do');
    const body = this.list(this.inner(DONE, stop));
    this.take('done');
    return body;
  }

  /** @brief case 词 in 模式) 列表 ;; … esac：seq 为 case 的词，各支在 arms。 */
  private caseCmd(stop: Stop): Compound {
    this.i += 4;
    this.enter();
    this.blanks();
    const cmd = compoundOf('case', [this.word()]);
    this.lines();
    this.take('in');
    for (;;) {
      this.lines();
      const before = this.i;
      const c = this.s[this.i];
      if (c === undefined || this.take('esac') || (c === ')' && stop.paren)) break;
      if (c === '(') this.i += 1;
      const words: Word[] = [];
      this.patterns(words);
      const body = this.list({ words: ESAC, paren: stop.paren, arm: true });
      this.blanks();
      const fall = this.s.startsWith(';;&', this.i) || this.s.startsWith(';&', this.i);
      if (this.s.startsWith(';;&', this.i)) this.i += 3;
      else if (this.s.startsWith(';;', this.i) || fall) this.i += 2;
      cmd.arms.push({ words, body, fall });
      if (this.i === before) this.i += 1;
    }
    this.leave();
    return cmd;
  }

  /** @brief case 一支的模式：用 | 分隔，到 ) 为止。 */
  private patterns(words: Word[]): void {
    for (;;) {
      this.blanks();
      const c = this.s[this.i];
      if (c === ')') {
        this.i += 1;
        return;
      }
      if (c === undefined || c === '\n') return;
      if (c === '|') this.i += 1;
      else this.wordInto(words);
    }
  }

  /** @brief { 列表; }。 */
  private group(stop: Stop): Compound {
    this.i += 1;
    this.enter();
    const body = this.list(this.inner(BRACE, stop));
    this.take('}');
    this.leave();
    return compoundOf('seq', [body]);
  }

  /** @brief ( 列表 )：子 shell；没有闭合时失败。 */
  private subshell(): Cmd {
    this.i += 1;
    this.enter();
    const body = this.list(PAREN);
    if (this.s[this.i] !== ')') this.scan.fail('unclosed bracket');
    this.i += 1;
    this.leave();
    const cmd = compoundOf('seq', [body]);
    cmd.sub = true;
    return this.trailing(cmd);
  }

  /**
   * @brief (( … )) 与 for ((…)) 的算术：里面的 < > 是比较；bash 会展开其中的 $(…)、`…`、${…}，它们照样分析
   *        （seq 为收集到的替换）；没有闭合时失败。
   */
  private arith(): Compound {
    const start = this.i;
    this.i += 2;
    const parts: Part[] = [];
    let depth = 0;
    for (;;) {
      const c = this.s[this.i];
      if (c === undefined) this.scan.fail('unclosed bracket');
      if (c === '$') this.dollar(parts, true);
      else if (c === '`') this.backtick(parts, true);
      else if (c === '"') this.double(parts);
      else {
        this.i += 1;
        if (c === '(') depth += 1;
        else if (c === ')' && depth > 0) depth -= 1;
        else if (c === ')' && this.s[this.i] === ')') break;
      }
    }
    this.i += 1;
    // 算术里的 PATH、IFS 可能被赋值（$((PATH=1))）：不是只读命令（§7.7 末尾第 6 条）
    if (/\b(?:PATH|IFS)\b/i.test(this.s.slice(start, this.i))) this.scan.notReadOnly();
    const subs = parts.filter((part) => part.k === 'sub');
    return compoundOf('seq', subs.length > 0 ? [{ parts: subs }] : []);
  }

  /** @brief [[ … ]]：里面的 < > 是比较，词里的替换照样分析。 */
  private cond(): Compound {
    this.i += 2;
    this.enter();
    const seq: (List | Word)[] = [];
    for (;;) {
      this.lines();
      const s = this.s;
      const c = s[this.i];
      if (c === undefined) break;
      if (s.startsWith(']]', this.i) && (this.i + 2 >= s.length || is(s[this.i + 2], META))) {
        this.i += 2;
        break;
      }
      if (is(c, META)) this.i += 1;
      else this.wordInto(seq);
    }
    this.leave();
    return compoundOf('seq', seq);
  }

  /** @brief function 名字 [()] 复合结构：函数体当作会被执行，就地分析。 */
  private functionCmd(stop: Stop): Cmd {
    this.i += 8;
    this.blanks();
    this.word();
    this.emptyParens();
    return this.functionBody(stop);
  }

  /** @brief 名字之后的 ()（中间可以有空白）。 */
  private emptyParens(): boolean {
    this.blanks();
    if (this.s[this.i] !== '(') return false;
    let j = this.i + 1;
    while (this.s[j] === ' ' || this.s[j] === '\t') j += 1;
    if (this.s[j] !== ')') return false;
    this.i = j + 1;
    return true;
  }

  /** @brief 函数体：换行之后的一条命令，包成一个复合结构（多一层嵌套：a() b() c() … 不会递归过深）。 */
  private functionBody(stop: Stop): Cmd {
    this.lines();
    this.enter();
    const body = this.command(stop);
    this.leave();
    const list: List = { items: body ? [{ pipes: [{ cmds: [body], or: false }], bg: false }] : [] };
    return compoundOf('seq', [list]);
  }

  /** @brief 复合结构之后的重定向：作用于整个结构（§7.3）。 */
  private trailing(cmd: Compound): Compound {
    for (;;) {
      this.blanks();
      const redir = this.redirect();
      if (!redir) return cmd;
      cmd.redirs.push(redir);
    }
  }

  /** @brief 简单命令：开头的赋值、词与任意位置的重定向；名字() 开头时是函数定义。 */
  private simple(stop: Stop): Cmd {
    const items: Item[] = [];
    let prefix = true;
    let assigns = false;
    for (;;) {
      this.gap();
      const c = this.s[this.i];
      const redir = isAt(this.s, this.i, REDIR_START) ? this.redirect() : null;
      if (redir) {
        items.push({ k: 'redir', r: redir });
        continue;
      }
      if (c === undefined || c === '\n' || c === ';' || c === '&' || c === '|' || c === ')') break;
      if (c === '(') {
        if (items.length === 1 && items[0].k === 'word' && this.emptyParens()) return this.functionBody(stop);
        this.i += 1;
        continue;
      }
      const before = this.i;
      const word = this.word();
      const assign = prefix && word.parts.length > 0 ? this.assignOf(word) : null;
      if (word.parts.length === 0) {
        if (this.i === before) this.i += 1;
      } else if (assign) {
        items.push(assign);
        assigns = true;
      } else {
        prefix = false;
        items.push({ k: 'word', w: word });
      }
    }
    return { k: 'simple', items, level: this.level, assigns };
  }

  /** @brief 开头的 名字=值 / 名字+=值 / 名字=(…)；不是赋值时为 null。 */
  private assignOf(word: Word): Item | null {
    const first = word.parts[0];
    if (first.k !== 'lit' || first.q || first.s.indexOf('=') <= 0) return null;
    const match = ASSIGNMENT.exec(first.s);
    if (!match) return null;
    const rest = first.s.slice(match[0].length);
    const parts: Part[] = rest === '' ? [] : [litPart(rest, false)];
    for (let k = 1; k < word.parts.length; k += 1) parts.push(word.parts[k]);
    const start = this.i;
    const array = parts.length === 0 && this.s[this.i] === '(' ? this.arrayWords() : null;
    return { k: 'assign', name: match[1], value: { parts }, array, arrayText: this.s.slice(start, this.i) };
  }

  /** @brief 数组赋值 名字=( 词… )。 */
  private arrayWords(): Word[] {
    this.i += 1;
    this.enter();
    const words: Word[] = [];
    for (;;) {
      this.lines();
      const c = this.s[this.i];
      if (c === undefined) this.scan.fail('unclosed bracket');
      if (c === ')') break;
      this.wordInto(words);
    }
    this.i += 1;
    this.leave();
    return words;
  }

  // ---- 重定向 ----

  /** @brief 当前位置的重定向（§7.3）：[n] 或 {名字} 加操作符，再加目标；不是时为 null，位置不变。 */
  private redirect(): Redir | null {
    const s = this.s;
    let j = this.i;
    while (j < s.length && s[j] >= '0' && s[j] <= '9') j += 1;
    let fd = s.slice(this.i, j);
    let named = false;
    if (j === this.i && s[j] === '{') {
      const match = /\{[A-Za-z_][A-Za-z0-9_]*\}(?=[<>])/y;
      match.lastIndex = j;
      if (match.exec(s)) {
        j = match.lastIndex;
        named = true;
      }
    }
    const op = this.operator(j, fd === '' && !named);
    if (op === null) return null;
    if (fd === '' && !named && (op === '<' || op === '>') && s[j + 1] === '(') return null;
    this.i = j + op.length;
    if (named) fd = '';
    return this.redirTarget(fd + op, op);
  }

  /** @brief 位置 j 上的重定向操作符（最长匹配）；amp 为可以是 &> / &>>。 */
  private operator(j: number, amp: boolean): string | null {
    const s = this.s;
    if (amp && s.startsWith('&>>', j)) return '&>>';
    if (amp && s.startsWith('&>', j)) return '&>';
    for (const op of ['>>', '>|', '>&', '<<<', '<<-', '<<', '<>', '<&', '>', '<']) {
      if (s.startsWith(op, j)) return op;
    }
    return null;
  }

  /** @brief 重定向的目标；here-doc 记下来等换行之后读正文。 */
  private redirTarget(form: string, op: string): Redir {
    this.blanks();
    const word = this.word();
    const target = word.parts.length > 0 ? word : null;
    if (op === '<<' || op === '<<-') {
      const { delim, quoted } = docDelim(word);
      const doc: Doc = { delim, quoted, strip: op === '<<-', body: '', parts: null };
      this.docs.push(doc);
      return { form, kind: 'doc', target: null, doc };
    }
    if (op === '<<<') return { form, kind: 'string', target, doc: null };
    const read = op === '<' || op === '<&' || (op === '>&' && isFdWord(target));
    if (read) return { form, kind: 'read', target, doc: null };
    return { form, kind: target ? 'write' : 'read', target, doc: null };
  }

  // ---- 词 ----

  /**
   * @brief 一个词：到引号外的分隔字符为止；开头的 <( / >( 是进程替换。只有空引号（""、''、$''、$""）的词是一个空的参数
   *        （一段引号里的空字面），不是没有词。
   */
  private word(): Word {
    const parts: Part[] = [];
    const s = this.s;
    const start = this.i;
    let quoted = false;
    while (this.i < s.length && !isAt(s, this.i, META | SPECIAL)) this.i += 1;
    if (this.i > start) parts.push(litPart(s.slice(start, this.i), false));
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === "'" || c === '"' || (c === '$' && (s[this.i + 1] === "'" || s[this.i + 1] === '"'))) quoted = true;
      if (is(c, META)) {
        if ((c === '<' || c === '>') && s[this.i + 1] === '(' && parts.length === 0) this.process(parts);
        else break;
      } else if (c === "'") this.single(parts);
      else if (c === '"') this.double(parts);
      else if (c === '\\') this.escape(parts);
      else if (c === '$') this.dollar(parts, false);
      else if (c === '`') this.backtick(parts, false);
      else this.run(parts, false, META | SPECIAL);
    }
    if (parts.length === 0 && quoted) parts.push(litPart('', true));
    return { parts };
  }

  /** @brief 一段普通字符，到属于类别 stop 的字符为止。 */
  private run(parts: Part[], q: boolean, stop: number): void {
    const s = this.s;
    const start = this.i;
    this.i += 1;
    while (this.i < s.length && !isAt(s, this.i, stop)) this.i += 1;
    pushLit(parts, s.slice(start, this.i), q);
  }

  /** @brief '…'：原样。 */
  private single(parts: Part[]): void {
    const end = this.s.indexOf("'", this.i + 1);
    if (end < 0) this.scan.fail('unclosed quote');
    pushLit(parts, this.s.slice(this.i + 1, end), true);
    this.i = end + 1;
  }

  /** @brief 引号外的 \：\x 是 x；\ 加换行是续行。 */
  private escape(parts: Part[]): void {
    const s = this.s;
    const next = s[this.i + 1];
    if (next === undefined) this.i += 1;
    else if (next === '\n') this.i += 2;
    else if (next === '\r' && s[this.i + 2] === '\n') this.i += 3;
    else {
      pushLit(parts, next, true);
      this.i += 2;
    }
  }

  /** @brief here-doc 正文里的 \：只转义 $ ` \ 与换行。 */
  private docEscape(parts: Part[]): void {
    const next = this.s[this.i + 1];
    if (next === '\n') this.i += 2;
    else if (next === '$' || next === '`' || next === '\\') {
      pushLit(parts, next, true);
      this.i += 2;
    } else {
      pushLit(parts, '\\', true);
      this.i += 1;
    }
  }

  /** @brief "…"：\ 只转义 $ ` " \ 与换行，其余 \ 原样；$… 与 `…` 照样展开。 */
  private double(parts: Part[]): void {
    const s = this.s;
    this.i += 1;
    for (;;) {
      const c = s[this.i];
      if (c === undefined) this.scan.fail('unclosed quote');
      if (c === '"') {
        this.i += 1;
        return;
      }
      if (c === '$') this.dollar(parts, true);
      else if (c === '`') this.backtick(parts, true);
      else if (c === '\\') this.doubleEscape(parts);
      else this.run(parts, true, DOUBLE_STOP);
    }
  }

  /** @brief 双引号里的 \。 */
  private doubleEscape(parts: Part[]): void {
    const next = this.s[this.i + 1];
    if (next === '\n') this.i += 2;
    else if (next === '$' || next === '`' || next === '"' || next === '\\') {
      pushLit(parts, next, true);
      this.i += 2;
    } else {
      pushLit(parts, '\\', true);
      this.i += 1;
    }
  }

  /** @brief $ 开头的：$'…'、$"…"、$((…))、$(…)、${…}、$名字、特殊参数；都不是时是字面的 $。 */
  private dollar(parts: Part[], quoted: boolean): void {
    const s = this.s;
    const next = s[this.i + 1];
    if (!quoted && next === "'") this.ansi(parts);
    else if (!quoted && next === '"') {
      this.i += 1;
      this.double(parts);
    } else if (next === '(' && s[this.i + 2] === '(') this.arithSub(parts, quoted);
    else if (next === '(') this.commandSub(parts, quoted);
    else if (next === '{') this.braceParam(parts, quoted);
    else if (next !== undefined && /[A-Za-z_0-9@*#?$!-]/.test(next)) this.simpleVar(parts, quoted);
    else {
      pushLit(parts, '$', quoted);
      this.i += 1;
    }
  }

  /** @brief $名字、$1、$@ 这类。 */
  private simpleVar(parts: Part[], q: boolean): void {
    const s = this.s;
    const start = this.i;
    this.i += 1;
    if (/[A-Za-z_]/.test(s[this.i])) {
      while (this.i < s.length && /[A-Za-z0-9_]/.test(s[this.i])) this.i += 1;
    } else this.i += 1;
    const raw = s.slice(start, this.i);
    parts.push(varPart(raw.slice(1), raw, q));
  }

  /** @brief $'…'：按 ANSI-C 转义还原。 */
  private ansi(parts: Part[]): void {
    const s = this.s;
    this.i += 2;
    let text = '';
    for (;;) {
      const c = s[this.i];
      if (c === undefined) this.scan.fail('unclosed quote');
      if (c === "'") break;
      if (c === '\\') text += this.ansiEscape();
      else {
        text += c;
        this.i += 1;
      }
    }
    this.i += 1;
    pushLit(parts, text, true);
  }

  /** @brief $'…' 里的一个转义：单字符、\xHH、\uHHHH、\UHHHHHHHH、\nnn、\cX。 */
  private ansiEscape(): string {
    const s = this.s;
    const c = s[this.i + 1];
    if (c === undefined) {
      this.i += 1;
      return '\\';
    }
    const code = /x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|c./y;
    code.lastIndex = this.i + 1;
    const match = code.exec(s);
    if (match) {
      this.i = code.lastIndex;
      const body = match[0];
      if (body[0] === 'c') return String.fromCharCode(body.charCodeAt(1) & 0x1f);
      const value = /[0-7]/.test(body[0]) ? parseInt(body, 8) : parseInt(body.slice(1), 16);
      return value <= 0x10ffff ? String.fromCodePoint(value) : '';
    }
    this.i += 2;
    return ANSI[c] ?? `\\${c}`;
  }

  /** @brief $((…))：内容不分析；没有闭合时失败。 */
  private arithSub(parts: Part[], q: boolean): void {
    const start = this.i;
    this.i += 1;
    this.enter();
    this.arith();
    this.leave();
    parts.push(subPart(this.s.slice(start, this.i), 'substitution', [], q, false));
  }

  /** @brief $(…)：内容递归按命令分析；没有闭合时失败。 */
  private commandSub(parts: Part[], q: boolean): void {
    const start = this.i;
    this.i += 2;
    this.enter();
    const list = this.list(PAREN);
    if (this.s[this.i] !== ')') this.scan.fail('unclosed command substitution');
    this.i += 1;
    this.leave();
    parts.push(subPart(this.s.slice(start, this.i), 'substitution', [list], q, false));
  }

  /** @brief <(…) / >(…)：不是文件目标，括号里的命令照常分析。 */
  private process(parts: Part[]): void {
    const start = this.i;
    this.i += 2;
    this.enter();
    const list = this.list(PAREN);
    if (this.s[this.i] !== ')') this.scan.fail('unclosed bracket');
    this.i += 1;
    this.leave();
    parts.push(subPart(this.s.slice(start, this.i), 'substitution', [list], false, true));
  }

  /** @brief `…`：去掉 \$ \` \\（双引号里还有 \"）的转义后递归分析；没有闭合时失败。 */
  private backtick(parts: Part[], q: boolean): void {
    const s = this.s;
    const start = this.i;
    let j = this.i + 1;
    let text = '';
    for (;;) {
      const c = s[j];
      if (c === undefined) this.scan.fail('unclosed command substitution');
      if (c === '`') break;
      const next = s[j + 1];
      const escaped = c === '\\' && (next === '$' || next === '`' || next === '\\' || (q && next === '"'));
      text += escaped ? next : c;
      j += escaped ? 2 : 1;
    }
    this.i = j + 1;
    this.enter();
    const list = new Parser(this.scan, text, this.level).parse();
    this.leave();
    parts.push(subPart(s.slice(start, this.i), 'substitution', [list], q, false));
  }

  /** @brief ${名字} 是变量；其余 ${…}（${x:-y}、${#x}）看不出来，里面的替换照样分析；没有闭合时失败。 */
  private braceParam(parts: Part[], q: boolean): void {
    const s = this.s;
    const start = this.i;
    const simple = /\$\{([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])\}/y;
    simple.lastIndex = start;
    const match = simple.exec(s);
    if (match) {
      this.i = simple.lastIndex;
      parts.push(varPart(match[1], match[0], q));
      return;
    }
    this.i += 2;
    this.enter();
    const inner: Part[] = [];
    this.braceBody(inner);
    this.leave();
    const lists = inner.flatMap((part) => (part.k === 'sub' ? part.lists : []));
    parts.push(subPart(s.slice(start, this.i), 'variable', lists, q, false));
  }

  /** @brief ${ 之后到配对的 }：引号、替换照样读（替换收进 inner）。 */
  private braceBody(inner: Part[]): void {
    const s = this.s;
    for (;;) {
      const c = s[this.i];
      if (c === undefined) this.scan.fail('unclosed bracket');
      if (c === '}') {
        this.i += 1;
        return;
      }
      if (c === "'") this.single(inner);
      else if (c === '"') this.double(inner);
      else if (c === '$') this.dollar(inner, true);
      else if (c === '`') this.backtick(inner, true);
      else this.i += c === '\\' ? 2 : 1;
    }
  }
}

// ---- 逐条处理 ----

/**
 * @brief 按执行顺序处理语法树：子 shell、多节管道的每一节、后台命令与替换结束后恢复当前目录；&& / ||、if、case、
 *        循环按 §7.7 算出几种可能的当前目录，之后的简单命令按每一种各处理一遍（Scan.eachState）。
 */
class Walker implements Sink {
  /** 顶层这一项开始时的可能（放到后台时恢复） */
  private start: State[];
  /** 顶层这一项的 && / || 列表 */
  private chain: Chain;

  constructor(private readonly scan: Scan, private readonly run: Run) {
    this.start = scan.statesOf(run);
    this.chain = scan.chain(run, this.start);
  }

  /** @brief 顶层一项开始。 */
  begin(): void {
    this.start = this.save();
    this.chain = this.scan.chain(this.run, this.start);
  }

  /** @brief 顶层一项里的一个管道开始。 */
  pipe(or: boolean): void {
    this.chain.next(or);
  }

  /** @brief 顶层的一条命令。 */
  top(cmd: Cmd, piped: boolean, isolated: boolean): void {
    if (!isolated) {
      this.cmd(cmd, false);
      return;
    }
    const saved = this.save();
    this.cmd(cmd, piped);
    this.restore(saved);
  }

  /** @brief 顶层一项结束：放到后台的恢复到开始时的状态。 */
  end(bg: boolean): void {
    this.chain.end();
    if (bg) this.restore(this.start);
  }

  /** @brief 一个列表。 */
  list(list: List): void {
    for (const item of list.items) this.andOr(item);
  }

  /** @brief 列表的一项：放到后台的在子 shell 里；几个管道时按 && / || 算当前目录（§7.7）。 */
  andOr(item: AndOr): void {
    const saved = item.bg ? this.save() : null;
    if (item.pipes.length === 1) this.pipeline(item.pipes[0]);
    else {
      const chain = this.scan.chain(this.run);
      for (const pipe of item.pipes) {
        chain.next(pipe.or);
        this.pipeline(pipe);
      }
      chain.end();
    }
    if (saved) this.restore(saved);
  }

  private save(): State[] {
    return this.scan.statesOf(this.run);
  }

  private restore(states: readonly State[]): void {
    this.scan.setStates(this.run, states);
  }

  /** @brief 管道：多于一节时每一节都在子 shell 里，第二节起从管道读标准输入。 */
  private pipeline(pipe: Pipeline): void {
    if (pipe.cmds.length === 1) {
      this.cmd(pipe.cmds[0], false);
      return;
    }
    pipe.cmds.forEach((cmd, index) => {
      const saved = this.save();
      this.cmd(cmd, index > 0);
      this.restore(saved);
    });
  }

  private cmd(cmd: Cmd, piped: boolean): void {
    if (cmd.k === 'simple') this.simple(cmd, piped);
    else this.compound(cmd);
  }

  /** @brief 复合结构：按 flow 处理；结构后的重定向按进入结构前的当前目录解析，记在主体之后。 */
  private compound(cmd: Compound): void {
    const before = this.save();
    if (cmd.loopVar !== null) this.scan.markVar(cmd.loopVar);
    if (cmd.flow === 'if') this.ifFlow(cmd.seq);
    else if (cmd.flow === 'case') this.caseFlow(cmd);
    else {
      this.parts(cmd.seq, 0, cmd.once);
      if (cmd.flow === 'loop') this.scan.loop(this.run, () => this.parts(cmd.seq, cmd.once, cmd.seq.length));
    }
    if (cmd.sub) this.restore(before);
    if (cmd.redirs.length === 0) return;
    const after = this.save();
    this.restore(before);
    this.scan.eachState(this.run, () => {
      const box: Box = { args: [], assigns: null, env: NO_ENV, stdin: null, queued: null, docs: null };
      for (const redir of cmd.redirs) this.redirect(redir, box, false);
      this.walkDocs(box);
    });
    this.restore(after);
  }

  /** @brief seq 的第 from 到 to（不含）项：列表照常；词（for 的词表、case 的词、[[ ]] 与算术里的替换）按每个可能求值。 */
  private parts(seq: (List | Word)[], from: number, to: number): void {
    for (let k = from; k < to; k += 1) {
      const part = seq[k];
      if ('items' in part) this.list(part);
      else this.scan.eachState(this.run, () => this.word(part));
    }
  }

  /**
   * @brief if（§7.7）：每个条件从前面的条件都不成立时的可能跑（失败的 cd 留在原处，所以含条件之前的），主体从它的条件
   *        跑完时的可能跑；结束时取各个主体与 else（没有 else 时为都不成立）的并。
   */
  private ifFlow(seq: (List | Word)[]): void {
    let failed = this.save();
    let ends: State[] = [];
    let k = 0;
    for (; k + 1 < seq.length; k += 2) {
      this.restore(failed);
      this.parts(seq, k, k + 1);
      failed = this.scan.union(failed, this.save());
      this.parts(seq, k + 1, k + 2);
      ends = this.scan.union(ends, this.save());
    }
    this.restore(failed);
    this.parts(seq, k, seq.length);
    this.restore(this.scan.union(ends, this.save()));
  }

  /**
   * @brief case（§7.7）：每一支（模式与列表）从进入时的可能跑；前一支以 ;& 或 ;;& 结束时也从前一支跑完时的可能跑；
   *        结束时取进入时（没有一支对上）与各支的并。
   */
  private caseFlow(cmd: Compound): void {
    this.parts(cmd.seq, 0, cmd.seq.length);
    const entry = this.save();
    let ends = entry;
    let carry: State[] | null = null;
    for (const arm of cmd.arms) {
      this.restore(carry ? this.scan.union(entry, carry) : entry);
      this.parts(arm.words, 0, arm.words.length);
      this.list(arm.body);
      const out = this.save();
      ends = this.scan.union(ends, out);
      carry = arm.fall ? out : null;
    }
    this.restore(ends);
  }

  /** @brief 求一个词的值；里面的替换按子 shell 分析。 */
  private word(word: Word): Arg {
    const first = word.parts[0];
    if (word.parts.length === 1 && first.k === 'lit') {
      return { pieces: [{ text: first.s, value: first.s, why: null, quoted: first.q, literal: true }] };
    }
    const pieces = word.parts.map((part) => {
      if (part.k === 'lit') return { text: part.s, value: part.s, why: null, quoted: part.q, literal: true };
      if (part.k === 'var') return this.scan.varPiece(part.name, part.raw, 'bash', this.run.cwd, part.q);
      for (const list of part.lists) {
        const saved = this.save();
        this.list(list);
        this.restore(saved);
      }
      return { text: part.raw, value: null, why: part.why, quoted: part.q, literal: false };
    });
    const only = word.parts[0];
    return { pieces, proc: word.parts.length === 1 && only.k === 'sub' && only.proc };
  }

  /** @brief 一条简单命令：按每一个可能的当前目录各处理一遍（§7.7）。 */
  private simple(cmd: Simple, piped: boolean): void {
    if (this.run.alts.length === 0) this.simpleOnce(cmd, piped);
    else if (!this.plain(cmd)) this.scan.eachState(this.run, () => this.simpleOnce(cmd, piped));
  }

  /**
   * @brief 几个可能时的捷径（结果同逐个处理）：只有字面词的 cd、不是特别命令也不是写入命令的简单命令，求值与查名单
   *        只做一遍，各个可能下只换目录或只记 leave。别的命令为假，照常逐个处理。
   */
  private plain(cmd: Simple): boolean {
    const args: Arg[] = [];
    for (const item of cmd.items) {
      if (item.k !== 'word' || item.w.parts.some((part) => part.k !== 'lit')) return false;
      args.push(this.word(item.w));
    }
    if (args.length === 0 || this.scan.globName(args[0])) return false;
    const key = this.scan.commandKey(args[0]);
    if (key === 'cd') {
      const operands = this.cdOperands(args);
      this.scan.eachState(this.run, () => { this.run.cwd = this.dirOf(operands, 'cd'); });
    } else if (SPECIAL_COMMANDS.has(key) || this.scan.isWriter(key)) return false;
    else this.scan.eachLeave(this.run, this.scan.bashReadOnly(key, args) ? null : this.scan.commandLabel(args[0]));
    return true;
  }

  /**
   * @brief 在一个当前目录下处理一条简单命令：开头赋值的变量在这条命令里看不出来；逐项求值、记命令名之前的重定向，
   *        再处理命令本身；命令名之后的重定向写入与 here-doc 正文里的替换在命令本身之后记（按命令之前的当前目录解析）。
   */
  private simpleOnce(cmd: Simple, piped: boolean): void {
    const undo = cmd.assigns ? this.prefixVars(cmd) : null;
    const box: Box = { args: [], assigns: null, env: NO_ENV, stdin: null, queued: null, docs: null };
    for (const item of cmd.items) {
      if (item.k === 'word') box.args.push(this.word(item.w));
      else if (item.k === 'redir') this.redirect(item.r, box, box.args.length > 0);
      else this.assign(item, box);
    }
    const before: State = { cwd: this.run.cwd, stack: this.run.stack };
    if (box.args.length === 0) {
      for (const assign of box.assigns ?? []) this.shellVar(assign.name, assign.value);
    } else {
      const stdin = box.stdin ?? (piped ? PIPED_STDIN : NO_STDIN);
      this.command(box.args, { env: box.env, stdin, level: cmd.level });
    }
    if (box.queued || box.docs) this.afterCommand(box, before);
    if (undo) undo();
  }

  /**
   * @brief 开头的赋值（§7.4）：TEMP、TMP、TMPDIR、PWD 在这条简单命令里看不出来，CDPATH 记下。
   * @return 命令结束时调用，撤销这一层
   */
  private prefixVars(cmd: Simple): () => void {
    const names: string[] = [];
    for (const item of cmd.items) {
      if (item.k === 'assign') names.push(item.name);
    }
    if (names.includes('CDPATH')) this.scan.cdpath = true;
    return this.scan.scopeVars(names);
  }

  /** @brief 命令本身处理完之后：记命令名之后的重定向写入，再按命令之前的当前目录分析 here-doc 正文里的替换。 */
  private afterCommand(box: Box, before: State): void {
    for (const write of box.queued ?? []) this.scan.write(write.form, write.text, write.target, false, false);
    if (!box.docs) return;
    const after = this.save();
    this.restore([before]);
    this.walkDocs(box);
    this.restore(after);
  }

  /** @brief 分析 here-doc 正文（没有引号的）里的 $(…)、`…`（§7.3），按子 shell。 */
  private walkDocs(box: Box): void {
    for (const doc of box.docs ?? []) {
      if (doc.parts) this.word(doc.parts);
    }
  }

  /** @brief 开头的一个赋值：值里的替换照样分析；GIT_DIR / GIT_WORK_TREE 只作用于这条命令。 */
  private assign(item: Extract<Item, { k: 'assign' }>, box: Box): void {
    this.scan.setsVar(item.name);
    let value = this.word(item.value);
    if (item.array) {
      for (const word of item.array) this.word(word);
      value = this.scan.unknown(item.arrayText, 'variable');
    }
    (box.assigns ??= []).push({ name: item.name, value });
    if (GIT_NAMES.has(item.name)) box.env = { ...box.env, [item.name]: { arg: value, shell: 'bash' } };
  }

  /** @brief shell 变量赋值（只有赋值、export 这类）：四个变量从此看不出来，CDPATH 记下，GIT_DIR / GIT_WORK_TREE 按 export。 */
  private shellVar(name: string, value: Arg): void {
    if (WORK_NAMES.has(name)) this.scan.markVar(name);
    if (name === 'CDPATH') this.scan.cdpath = true;
    if (GIT_NAMES.has(name)) this.scan.gitEnv.set(name as GitName, { arg: value, shell: 'bash' });
  }

  /**
   * @brief 一个重定向：写入按当前目录解析后记下（late 为在命令名之后：放进 box.queued，命令本身之后再记）；
   *        here-doc 放进 box.docs，正文里的替换之后再分析；here-doc / here-string / < 文件 成为标准输入。
   */
  private redirect(redir: Redir, box: Box, late: boolean): void {
    if (redir.kind === 'doc' && redir.doc) {
      box.stdin = this.docStdin(redir.doc);
      (box.docs ??= []).push(redir.doc);
      return;
    }
    const arg = redir.target ? this.word(redir.target) : null;
    if (redir.kind === 'string' && arg) {
      const value = this.scan.valueOf(arg);
      box.stdin = value === null ? PIPED_STDIN : { kind: 'text', text: value };
    } else if (redir.kind === 'read' && /^0?<$/.test(redir.form)) box.stdin = { kind: 'file', text: '' };
    if (redir.kind !== 'write' || !arg) return;
    const target = this.scan.resolve(arg, this.run.cwd, 'bash', false);
    if (!target) return;
    if (late) (box.queued ??= []).push({ form: redir.form, text: this.scan.text(arg), target });
    else this.scan.write(redir.form, this.scan.text(arg), target, false, false);
  }

  /**
   * @brief here-doc 作为标准输入：有引号时正文原样；没有引号且没有展开时为去掉转义的正文；有替换或看不出来的变量时
   *        看不出来。只看正文的各段，不分析其中的替换（walkDocs 在命令之后分析）。
   */
  private docStdin(doc: Doc): Stdin {
    if (doc.quoted || !doc.parts) return { kind: 'text', text: doc.body };
    let text = '';
    for (const part of doc.parts.parts) {
      if (part.k === 'sub') return PIPED_STDIN;
      if (part.k === 'lit') text += part.s;
      else {
        const value = this.scan.varPiece(part.name, part.raw, 'bash', this.run.cwd, part.q).value;
        if (value === null) return PIPED_STDIN;
        text += value;
      }
    }
    return { kind: 'text', text };
  }

  // ---- 命令 ----

  /**
   * @brief 一条命令（§7.4、§7.5、§7.7）：先去掉前缀与包装找出真正的命令，再按写法、换目录与只读名单处理。
   *        命令名有变量、替换、通配符或花括号展开（{rm,-rf,x}）时看不出跑的是什么，解析失败。
   */
  private command(args: Arg[], ctx: Ctx): void {
    const name = args[0];
    if (unknownName(name) || this.scan.globName(name)) {
      this.scan.fail('the command name comes from a variable or substitution');
    }
    const key = this.scan.commandKey(name);
    if (SPECIAL_COMMANDS.has(key)
      && (this.builtin(key, args, ctx) || this.wrapper(key, args, ctx) || this.nestedShell(key, args, ctx))) return;
    const parsed = key === 'uniq' ? null : this.scan.gnuOf(key, args.slice(1));
    if (parsed) this.writer(key, parsed);
    // 当前目录没换过时只为只读命令的判断（§7.7 末尾）调 leave：一旦有过非只读命令就不必再查
    if ((this.run.cwd.form !== null || this.scan.onlyReads) && !this.scan.bashReadOnly(key, args)) {
      this.scan.leave(this.run.cwd, this.scan.commandLabel(name));
    }
  }

  /** @brief 换目录、设变量的内建命令与 git；处理了时为真（dirs 只读，-c 清空 pushd 的栈）。 */
  private builtin(key: string, args: Arg[], ctx: Ctx): boolean {
    if (key === 'cd') this.run.cwd = this.dirOf(this.cdOperands(args), 'cd');
    else if (key === 'pushd') this.pushd(args);
    else if (key === 'popd') this.popd(args);
    else if (key === 'dirs') {
      if (args.slice(1).some((arg) => /^-[lpv]*c/.test(this.scan.valueOrText(arg)))) this.run.stack = null;
    } else if (DECLARERS.has(key)) this.declare(args);
    else if (key === 'unset') {
      for (const arg of args.slice(1)) this.scan.unsetVar(this.scan.valueOrText(arg));
    } else if (key === 'read') {
      for (const arg of args.slice(1)) this.scan.markVar(this.scan.valueOrText(arg));
    } else if (key === 'git') this.scan.git(args.slice(1), this.run.cwd, 'bash', ctx.env);
    else return false;
    return true;
  }

  /** @brief 包装命令（§7.4 的表）：去掉它和它的选项，后面的词是真正的命令；处理了时为真。 */
  private wrapper(key: string, args: Arg[], ctx: Ctx): boolean {
    switch (key) {
      case 'env': this.env(args, ctx); return true;
      case 'command': this.commandWrapper(args, ctx); return true;
      case 'builtin': case 'nohup': this.inner(args.slice(1), ctx); return true;
      case 'time': this.inner(args.slice(this.skip(args, 1, /^-p$/)), ctx); return true;
      case 'exec': case 'nice': this.inner(args.slice(this.scan.wrapperStart(args, key)), ctx); return true;
      case 'timeout': this.inner(args.slice(this.scan.wrapperStart(args, key) + 1), ctx); return true;
      case 'xargs': this.xargs(args, ctx); return true;
      case 'find': this.find(args, ctx); return true;
      default: return false;
    }
  }

  /** @brief 嵌套的 shell、eval 与 trap（§7.4）；处理了时为真。 */
  private nestedShell(key: string, args: Arg[], ctx: Ctx): boolean {
    if (key === 'eval') this.evalText(args.slice(1), ctx);
    else if (key === 'trap') this.trap(args, ctx);
    else if (key === 'bash' || key === 'sh' || key === 'pwsh' || key === 'powershell') {
      const call = { cwd: this.run.cwd, level: ctx.level, stdin: ctx.stdin, env: ctx.env };
      if (this.scan.shellArgs(key, args, call) === 'script') {
        this.scan.leave(this.run.cwd, this.scan.commandLabel(args[0]));
      }
    } else return false;
    return true;
  }

  /**
   * @brief 包装里的真正命令：多一层嵌套（§7.8），一长串包装（nohup nohup …）不会递归过深；没有时什么都不做
   *        （只打印或只有重定向）。
   */
  private inner(args: Arg[], ctx: Ctx): void {
    if (args.length > 0) this.command(args, { env: ctx.env, stdin: ctx.stdin, level: this.scan.deeper(ctx.level) });
  }

  /** @brief 从 from 起跳过值匹配 pattern 的参数。 */
  private skip(args: Arg[], from: number, pattern: RegExp): number {
    let k = from;
    while (k < args.length && pattern.test(this.scan.valueOrText(args[k]))) k += 1;
    return k;
  }

  /**
   * @brief env：跳过选项（短选项可以组合），然后的 名字=值 同开头的赋值；-i / -u 让四个变量看不出来；-C、-S、--chdir、
   *        --split-string 与认不出的长选项解析失败；没有命令时只打印。
   */
  private env(args: Arg[], ctx: Ctx): void {
    const scoped: string[] = [];
    const env: GitEnv = { ...ctx.env };
    let k = 1;
    let options = true;
    while (k < args.length) {
      const value = this.scan.valueOrText(args[k]);
      const next = k + 1 < args.length ? this.scan.valueOrText(args[k + 1]) : '';
      if (options && value === '--') {
        options = false;
        k += 1;
      } else if (options && value.startsWith('-')) k += this.envOption(value, next, scoped);
      else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
        this.envAssign(args[k], value, scoped, env);
        options = false;
        k += 1;
      } else break;
    }
    for (const name of scoped) this.scan.touchVar(name);
    const undo = this.scan.scopeVars(scoped);
    this.inner(args.slice(k), { ...ctx, env });
    undo();
  }

  /** @brief env 的一个选项（单独的 - 同 -i）；返回用掉几个词。 */
  private envOption(value: string, next: string, scoped: string[]): number {
    if (value === '-') {
      scoped.push(...CLEARED);
      return 1;
    }
    if (value.startsWith('--')) {
      const eq = value.indexOf('=');
      const name = value.slice(2, eq < 0 ? undefined : eq);
      if (name === 'ignore-environment') scoped.push(...CLEARED);
      if (name === 'unset') scoped.push(eq < 0 ? next : value.slice(eq + 1));
      return this.scan.longOption(value, 'env');
    }
    const found = this.scan.cluster(value, 'uCS');
    if (found.option === 'C' || found.option === 'S') this.scan.fail(`unsupported option -${found.option}`);
    if (found.flags.includes('i')) scoped.push(...CLEARED);
    if (found.option === 'u') scoped.push(found.rest || next);
    return found.used;
  }

  /** @brief env 的 名字=值。 */
  private envAssign(arg: Arg, value: string, scoped: string[], env: GitEnv): void {
    const name = value.slice(0, value.indexOf('='));
    this.scan.setsVar(name);
    scoped.push(name);
    if (name === 'CDPATH') this.scan.cdpath = true;
    if (GIT_NAMES.has(name)) env[name as GitName] = { arg: this.scan.slice(arg, name.length + 1), shell: 'bash' };
  }

  /** @brief command [-p] 命令；-v / -V 只打印。 */
  private commandWrapper(args: Arg[], ctx: Ctx): void {
    let k = 1;
    for (; k < args.length; k += 1) {
      const value = this.scan.valueOrText(args[k]);
      if (!/^-[pvV]+$/.test(value)) break;
      if (/[vV]/.test(value)) return;
    }
    this.inner(args.slice(k), ctx);
  }

  /** @brief xargs：输入的项看不出来——有替换串时含它的词，没有时在末尾补一个；没有命令时是 echo。 */
  private xargs(args: Arg[], ctx: Ctx): void {
    let k = 1;
    let replace: string | null = null;
    while (k < args.length) {
      const value = this.scan.optionText(args[k]);
      if (value === null || !value.startsWith('-') || value === '-') break;
      if (value === '--') {
        k += 1;
        break;
      }
      const next = k + 1 < args.length ? this.scan.valueOrText(args[k + 1]) : null;
      const option = this.scan.xargsOption(value, next);
      replace = option.replace ?? replace;
      k += option.used;
    }
    let inner = args.slice(k);
    if (inner.length === 0) inner = [this.scan.lit('echo')];
    const mark = replace;
    if (mark === null) inner = [...inner, this.scan.input()];
    else inner = inner.map((arg, index) => (index > 0 && this.scan.text(arg).includes(mark) ? this.scan.input() : arg));
    this.inner(inner, { ...ctx, stdin: NO_STDIN });
  }

  /** @brief find：-exec 这类到 ; 或 + 之间是一条命令（{} 看不出来）；有 -delete 这类时不是只读。 */
  private find(args: Arg[], ctx: Ctx): void {
    let readOnly = true;
    for (let k = 1; k < args.length; k += 1) {
      const value = this.scan.valueOrText(args[k]);
      if (FIND_EXEC.has(value)) {
        const inner: Arg[] = [];
        let end = k + 1;
        for (; end < args.length; end += 1) {
          const arg = args[end];
          const word = this.scan.valueOrText(arg);
          if (word === ';' || word === '+') break;
          inner.push(this.scan.text(arg).includes('{}') ? this.scan.input() : arg);
        }
        this.inner(inner, { ...ctx, stdin: NO_STDIN });
        k = end;
      } else if (FIND_WRITES.has(value)) readOnly = false;
    }
    if (!readOnly) this.scan.leave(this.run.cwd, this.scan.commandLabel(args[0]));
  }

  /**
   * @brief eval：词用空格连起来按 bash 分析（在当前 shell 里执行，换目录延续；前缀的 GIT_DIR= / GIT_WORK_TREE=
   *        里面同样看到）；有看不出来的部分时解析失败。
   */
  private evalText(words: Arg[], ctx: Ctx): void {
    const text = words.map((arg) => this.scan.mustText(arg)).join(' ');
    const level = this.scan.deeper(ctx.level);
    this.scan.withGitEnv(ctx.env, () => scanBashText(this.scan, text, this.run, level));
  }

  /** @brief trap 动作 信号…：动作按 bash 分析；-p、-l、-、'' 不分析。 */
  private trap(args: Arg[], ctx: Ctx): void {
    let k = 1;
    if (k < args.length && this.scan.valueOrText(args[k]) === '--') k += 1;
    if (k >= args.length) return;
    const value = this.scan.valueOrText(args[k]);
    if (value === '' || value === '-' || value === '-p' || value === '-l') return;
    const call = { cwd: this.run.cwd, level: ctx.level, stdin: NO_STDIN, env: ctx.env };
    this.scan.nested('bash', this.scan.mustText(args[k]), call);
  }

  /**
   * @brief export、declare、local、readonly、typeset 的参数：名字=值 是设值（§7.4、§7.7 末尾第 5 条）；只有名字的（含选项）
   *        按 touchVar 看是不是 PATH、IFS 或看不出的名字（第 6 条）。
   */
  private declare(args: Arg[]): void {
    for (const arg of args.slice(1)) {
      const text = this.scan.optionText(arg);
      const match = text === null ? null : ASSIGNMENT.exec(text);
      if (!match) this.scan.touchVar(text);
      else {
        this.scan.setsVar(match[1]);
        this.shellVar(match[1], this.scan.slice(arg, match[0].length));
      }
    }
  }

  // ---- 换目录（§7.7） ----

  /** @brief cd 的操作数：跳过 -L -P -e -@ 与 --。 */
  private cdOperands(args: Arg[]): Arg[] {
    let k = 1;
    while (k < args.length && /^-[LPe@]+$/.test(this.scan.valueOrText(args[k]))) k += 1;
    if (k < args.length && this.scan.valueOrText(args[k]) === '--') k += 1;
    return args.slice(k);
  }

  /** @brief cd / pushd 换到的目录：没有参数（HOME）、-、多个操作数、设过 CDPATH 后的相对名字都看不出来。 */
  private dirOf(operands: Arg[], form: string): Cwd {
    if (operands.length === 0) return { dir: null, form, text: '~' };
    const text = operands.length === 1 ? this.scan.text(operands[0])
      : operands.map((arg) => this.scan.text(arg)).join(' ');
    if (operands.length > 1) return { dir: null, form, text };
    const value = this.scan.valueOf(operands[0]);
    if (value === '-' || (value !== null && /^[+-]\d+$/.test(value))) return { dir: null, form, text };
    if (this.scan.cdpath && value !== null && !/^(?:[\\/.~]|[A-Za-z]:)/.test(value)) return { dir: null, form, text };
    const from = this.run.cwd;
    return this.scan.moveTo(operands[0], from, form, () => {
      return { dir: this.scan.resolve(operands[0], from, 'bash', false)?.path ?? null, form, text };
    });
  }

  /** @brief pushd / popd 的操作数：跳过 -L -P -e -@ -n（可以组合）与 --；n 为有没有 -n。 */
  private stackOperands(args: Arg[]): { operands: Arg[]; n: boolean } {
    let k = 1;
    let n = false;
    for (; k < args.length; k += 1) {
      const value = this.scan.valueOrText(args[k]);
      if (value === '--') return { operands: args.slice(k + 1), n };
      if (!/^-[LPe@n]+$/.test(value)) break;
      if (value.includes('n')) n = true;
    }
    return { operands: args.slice(k), n };
  }

  /**
   * @brief pushd 目录：先把当前目录压栈再换过去；没有参数时看不出来。-n 只把目录放进栈（成为下一次 popd 回到的地方），
   *        不换目录。
   */
  private pushd(args: Arg[]): void {
    const { operands, n } = this.stackOperands(args);
    const target = operands.length === 0 ? { dir: null, form: 'pushd', text: 'pushd' } : this.dirOf(operands, 'pushd');
    if (n) {
      this.run.stack = this.scan.push(this.run.stack, target);
      return;
    }
    this.run.stack = this.scan.push(this.run.stack, this.run.cwd);
    this.run.cwd = target;
  }

  /**
   * @brief popd：回到这条命令里上一次 pushd 前的目录；栈空时看不出来。-n 只去掉栈里的那一项，不换目录。
   *        +N / -N 去掉的是栈里别的项：目录（没有 -n 时）与之后的栈都看不出来。
   */
  private popd(args: Arg[]): void {
    const { operands, n } = this.stackOperands(args);
    if (operands.length > 0) {
      const lost: Cwd = { dir: null, form: 'popd', text: this.scan.text(operands[0]) };
      if (!n) this.run.cwd = lost;
      this.run.stack = { top: lost, rest: null, depth: 1 };
      return;
    }
    const saved = this.run.stack?.top;
    this.run.stack = this.run.stack?.rest ?? null;
    if (!n) this.run.cwd = saved ?? { dir: null, form: 'popd', text: 'popd' };
  }

  // ---- 认得出的写法（§7.5） ----

  /** @brief tee、cp、mv、rm、rmdir、mkdir、touch、ln、sed -i 的写入目标（parsed 为按 GNU 的规则分好的参数）。 */
  private writer(key: string, parsed: Gnu): void {
    if (key === 'cp' || key === 'mv') this.copy(key, parsed);
    else if (key === 'ln') this.link(parsed);
    else if (key === 'sed') this.sed(parsed);
    else {
      const remove = key === 'rm' || key === 'rmdir';
      for (const operand of parsed.operands) this.put(key, operand, remove, false);
    }
  }

  /** @brief 记一个目标。 */
  private put(form: string, arg: Arg, remove: boolean, into: boolean): void {
    const target = this.scan.resolve(arg, this.run.cwd, 'bash', false);
    if (target) this.scan.write(form, this.scan.text(arg), target, remove, into);
  }

  /** @brief 按出现顺序最后一个 keys 之一的值。 */
  private last(parsed: Gnu, keys: readonly string[]): Arg | null {
    for (let k = parsed.options.length - 1; k >= 0; k -= 1) {
      const option = parsed.options[k];
      if (keys.includes(option.key) && option.value) return option.value;
    }
    return null;
  }

  /** @brief cp / mv：有 -t 时为它（落进目录）；否则最后一个操作数（两个以上的源时落进目录）；mv 的源都是删除。 */
  private copy(form: string, parsed: Gnu): void {
    const ops = parsed.operands;
    const dir = this.last(parsed, ['t', 'target-directory']);
    const target = dir ?? (ops.length >= 2 ? ops[ops.length - 1] : null);
    if (form === 'mv') {
      const sources = dir ? ops : ops.slice(0, -1);
      for (const source of sources) this.put(form, source, true, false);
    }
    if (target) this.put(form, target, false, dir !== null || ops.length >= 3 || this.scan.intoDir(target));
  }

  /** @brief ln：有 -t 时为它；两个以上操作数时最后一个；只有一个时是当前目录下与它同名的文件。 */
  private link(parsed: Gnu): void {
    const ops = parsed.operands;
    const dir = this.last(parsed, ['t', 'target-directory']);
    if (dir) this.put('ln', dir, false, true);
    else if (ops.length >= 2) {
      const last = ops[ops.length - 1];
      this.put('ln', last, false, ops.length >= 3 || this.scan.intoDir(last));
    }
    else if (ops.length === 1) {
      const value = this.scan.valueOf(ops[0]);
      const base = (value ?? this.scan.text(ops[0])).replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
      const why = ops[0].pieces.find((piece) => piece.why !== null)?.why ?? 'variable';
      this.put('ln', value === null ? this.scan.unknown(base, why) : this.scan.lit(base), false, false);
    }
  }

  /** @brief sed -i / --in-place：文件操作数；没有 -e、-f 时第一个操作数是脚本。 */
  private sed(parsed: Gnu): void {
    const keys = parsed.options.map((option) => option.key);
    if (!keys.includes('i') && !keys.includes('in-place')) return;
    const script = keys.some((key) => key === 'e' || key === 'f' || key === 'expression' || key === 'file');
    for (const file of script ? parsed.operands : parsed.operands.slice(1)) this.put('sed -i', file, false, false);
  }
}

// ---- 入口 ----

/**
 * @brief 按 Git Bash 的语法分析一段文字（整条命令、eval 的文字，或经 Scan.nested 的嵌套文字），结果记在 scan 上。
 * @param scan 这次分析的状态
 * @param text 文字
 * @param run 执行状态（当前目录与 pushd 的栈）；eval 与外面共用
 * @param level 这段文字所在的嵌套层数
 */
export function scanBashText(scan: Scan, text: string, run: Run, level: number): void {
  new Parser(scan, text, level).stream(new Walker(scan, run));
}
