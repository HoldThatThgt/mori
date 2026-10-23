// MD-15 的一项附加检查（docs/specs/model-discovery.md §13.3；负责人的规则：不留未完成项）：这次工作新加的行里
// 不能有推迟实现的标记。新加的行 = 已跟踪的文件：HEAD 与 origin/app-v0 的 merge-base 到工作区的 git diff 里新增的行；
// 没跟踪、也没被忽略的文件（git ls-files --others --exclude-standard）：每一行。只看 app/src 与 app/tests，
// 不看 app/tests/fixtures/（录下的服务数据，不是这次写的代码）。没改过的旧代码里本来就有这些词，所以只看新加的行；
// 只有行尾 CR 变了的行（例如编辑器把整个文件从 LF 换成 CRLF）不算新加的行（--ignore-cr-at-eol）。
// 标记见 MARKERS（四个英文标记与一个中文标记，英文的不分大小写）；模式里用字符类，这个文件自己的模式不会认出自己。
// FLAG_FILES 的三个文件实现"跳过的与标为待办的测试算失败"（单元报告器的严格模式与覆盖检查，§13.3），那里全小写的
// 英文"待办"一词是 node --test 的标记名（data 的字段名），不算推迟的标记；大写或大小写混写的照查，另外四个标记也照查。
// 每个命中打印一行 "<文件>:<行号>: <内容>"（文件相对仓库根目录），最后一行 "PASS MD-15 …" 或 "FAIL MD-15 …"
// （同其他套件；tests/ui/v1-models-existing.mjs --id MD-15 把它记作 "MD-15 md-markers"）。
// 用法（在 app/ 下）：node tests/md-markers.mjs
// 退出码：没有命中为 0，有命中为 1，git 命令失败（例如没有 origin/app-v0）为 2。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..', '..');
/**
 * 这次工作从它分出：比较的起点是 HEAD 与它的 merge-base。用远端的 app-v0：分支合并的是 origin/app-v0（合并后
 * 本地的 app-v0 可能还停在旧的提交上，那时它带进来的别人的行会被算成这次新加的）
 */
const BASE_BRANCH = 'origin/app-v0';
/** 只看这两处，录下的服务数据不看（git 的 pathspec，相对仓库根目录） */
const PATHSPECS = ['app/src', 'app/tests', ':(exclude)app/tests/fixtures'];
/** 命中一行时打印的内容最多多少字符 */
const TEXT_MAX = 200;

/**
 * @brief 推迟实现的标记。pattern 为模式（字符类让这一行的源码不匹配它自己）；flagName 为 FLAG_FILES 里先从行里去掉的
 *        node --test 标记名（只认全小写，区分大小写），没有时为 null。
 */
const MARKERS = [
  { pattern: /\bT[O]DO/i, flagName: /t[o]do/g },
  { pattern: /\bFIX[M]E/i, flagName: null },
  { pattern: /\bnot[\s_-]*implem[e]nted/i, flagName: null },
  { pattern: /\bl[a]ter\b/i, flagName: null },
  { pattern: /待[实]现/, flagName: null },
];
/** 实现"跳过的与标为待办的测试算失败"的文件：那里全小写的英文"待办"一词是 node --test 的标记名（相对仓库根目录） */
const FLAG_FILES = new Set([
  'app/tests/unit/reporter.mjs', 'app/tests/spec-coverage.mjs', 'app/tests/unit/taskboard/spec-coverage.test.mjs',
]);

/** @brief 在仓库根目录跑一条 git 命令，返回标准输出（文件名不转义）。 */
function git(args) {
  return execFileSync('git', ['-C', repoRoot, '-c', 'core.quotepath=off', ...args],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
}

/**
 * @brief 从 git diff --unified=0 --no-prefix 的输出里取出新增的行。
 * @param diff git diff 的全文
 * @return [{ file, line, text }]：file 相对仓库根目录，line 为新文件里的行号
 */
function addedLinesOfDiff(diff) {
  const added = [];
  let file = null;
  let line = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    const text = raw.replace(/\r$/, '');
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (text.startsWith('diff --git ')) [file, inHunk] = [null, false];
    else if (hunk) [line, inHunk] = [Number(hunk[1]), true];
    else if (!inHunk && text.startsWith('+++ ')) file = text === '+++ /dev/null' ? null : text.slice(4);
    else if (inHunk && text.startsWith('+')) {
      if (file) added.push({ file, line, text: text.slice(1) });
      line += 1;
    } else if (inHunk && text.startsWith(' ')) line += 1;
  }
  return added;
}

/**
 * @brief 没跟踪的文件的每一行（含 NUL 字节的二进制文件跳过）。
 * @return [{ file, line, text }]
 */
function untrackedLines() {
  const files = git(['ls-files', '-z', '--others', '--exclude-standard', '--', ...PATHSPECS]).split('\0')
    .filter(Boolean);
  return files.flatMap((file) => {
    const content = readFileSync(join(repoRoot, file));
    if (content.includes(0)) return [];
    const texts = content.toString('utf8').split(/\r?\n/);
    if (texts.at(-1) === '') texts.pop();
    return texts.map((text, index) => ({ file, line: index + 1, text }));
  });
}

/** @brief 一行里有没有推迟实现的标记（FLAG_FILES 里的文件先去掉 flagName 再查）。 */
const hasMarker = ({ file, text }) => MARKERS.some((marker) => marker.pattern.test(
  marker.flagName && FLAG_FILES.has(file) ? text.replace(marker.flagName, '') : text));

/** @brief 读出新加的行、找标记、打印并设置退出码。 */
function main() {
  let base;
  let lines;
  try {
    base = git(['merge-base', 'HEAD', BASE_BRANCH]).trim();
    const diff = git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-prefix', '-M', '--unified=0',
      '--ignore-cr-at-eol', base, '--', ...PATHSPECS]);
    lines = [...addedLinesOfDiff(diff), ...untrackedLines()];
  } catch (error) {
    console.log(`FAIL MD-15 md-markers: cannot list the added lines (${String(error.message).split('\n')[0]})`);
    process.exit(2);
  }
  const hits = lines.filter(hasMarker);
  for (const hit of hits) console.log(`${hit.file}:${hit.line}: ${hit.text.trim().slice(0, TEXT_MAX)}`);
  const files = new Set(lines.map((entry) => entry.file)).size;
  const scope = `${lines.length} added lines in ${files} files under app/src and app/tests (fixtures excluded), `
    + `compared with ${base.slice(0, 7)} (merge-base of HEAD and ${BASE_BRANCH}) plus untracked files`;
  console.log(hits.length ? `FAIL MD-15 md-markers: ${hits.length} deferral markers in ${scope}`
    : `PASS MD-15 md-markers: no deferral markers in ${scope}`);
  process.exitCode = hits.length ? 1 : 0;
}

main();
