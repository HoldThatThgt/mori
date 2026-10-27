// 命令分析：Git Bash（docs/specs/file-system-permissions.md §7.3–§7.9，docs/specs/file-system.md §19.2 的 FS-42…FS-50）。
// 先逐行跑 §7.9 的 Git Bash 表（B1–B118，含 B42a–B42c、B105a、B105b），测试名以所属条目和行号开头，属于两个条目的行
// 各跑一次；再补 §19.2 要求的“每种写法至少一行”（§7.4 的三张表、§7.5 的命令与选项、落进目录、§7.6 的 bash 一列、
// §7.7 的只读名单、§7.8 的每个原因），以及 §17 里 2026-10-27 登记的实现时补充的做法（各归到最近的条目下）。
// 命令文字都是手写的（synthetic）；期望照规格的表，表里没写出的 text 按 §7.2 的规则（去掉引号与转义后的原文）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import {
  DEL, GIT_READ_ONLY, GIT_READ_ONLY_NAMES, INTO, NONE, P, W, expectAll, fail, leavesOf, lv, megabyte, ok, okAnyOrder,
  p, row, sameSet, scan, scanModule, t, tableTests, timeShapes, w, wq, wr, writesOf,
} from './scan-helpers.mjs';

/** B114 的工作路径：主文件夹 C:\r 下的 worktree */
const WORKTREE = 'C:\\r\\.mori\\worktrees\\a';

/** @brief n 层嵌套的 $( … )：echo $(echo $(… $(ls)))，最里面是 ls。 */
function nested(levels) {
  return levels === 0 ? 'ls' : `echo $(${nested(levels - 1)})`;
}

// ---- §7.9 Git Bash 表：B1–B61 ----

const ROWS_A = [
  row('B1', 'npm run build', NONE),
  row('B2', 'npm run build > out.log', ok([wr('>', 'out.log', p('out.log'))])),
  row('B3', 'npm run build > ../out.log', ok([wr('>', '../out.log', w('out.log'))])),
  row('B4', 'echo hi >> notes/a.md', ok([wr('>>', 'notes/a.md', p('notes', 'a.md'))])),
  row('B5', 'make 2> err.txt; make 2>>err2.txt',
    ok([wr('2>', 'err.txt', p('err.txt')), wr('2>>', 'err2.txt', p('err2.txt'))])),
  row('B6', 'make &> all.log; make &>> all2.log',
    ok([wr('&>', 'all.log', p('all.log')), wr('&>>', 'all2.log', p('all2.log'))])),
  row('B7', 'echo x >| f; exec 3<> rw.bin; make >& b.log',
    ok([wr('>|', 'f', p('f')), wr('3<>', 'rw.bin', p('rw.bin')), wr('>&', 'b.log', p('b.log'))])),
  row('B8', 'exec {fd}>named.log', ok([wr('>', 'named.log', p('named.log'))])),
  row('B9', 'cmd > /dev/null 2>&1; cmd 2>/dev/null; cmd &>/dev/null; cmd >&2; cmd 1>&2; exec 3>&-; '
    + 'cmd > /dev/stderr', NONE),
  row('B10', 'sort < in.txt; cat <<< "x"', NONE),
  row('B11', '> out echo hi', ok([wr('>', 'out', p('out'))])),
  row('B12', 'ls | tee list.txt', ok([wr('tee', 'list.txt', p('list.txt'))])),
  row('B13', 'ls | tee -a ../l.txt /dev/null', ok([wr('tee', '../l.txt', w('l.txt'))])),
  row('B14', 'cp a.txt b.txt', ok([wr('cp', 'b.txt', p('b.txt'))])),
  row('B15', 'cp -r src/ ../backup/; cp x ..; cp a b ../c',
    ok([wr('cp', '../backup/', w('backup'), INTO), wr('cp', '..', W, INTO), wr('cp', '../c', w('c'), INTO)])),
  row('B16', 'cp -t dist a b; cp --target-directory=../d a; cp --target-directory ../e a',
    ok([wr('cp', 'dist', p('dist'), INTO), wr('cp', '../d', w('d'), INTO), wr('cp', '../e', w('e'), INTO)])),
  row('B17', 'cp -S .bak a b; cp --backup=numbered a c; cp only-one; cp --sparse always a d',
    ok([wr('cp', 'b', p('b')), wr('cp', 'c', p('c')), wr('cp', 'd', p('d'))])),
  row('B18', 'mv a.txt ../b.txt', ok([wr('mv', 'a.txt', p('a.txt'), DEL), wr('mv', '../b.txt', w('b.txt'))])),
  row('B19', 'mv -t ../d x y',
    ok([wr('mv', 'x', p('x'), DEL), wr('mv', 'y', p('y'), DEL), wr('mv', '../d', w('d'), INTO)])),
  row('B20', 'rm -rf build ../tmp.txt',
    ok([wr('rm', 'build', p('build'), DEL), wr('rm', '../tmp.txt', w('tmp.txt'), DEL)])),
  row('B21', 'rm -- -weird.txt', ok([wr('rm', '-weird.txt', p('-weird.txt'), DEL)])),
  row('B22', 'rm -rf .', ok([wr('rm', '.', P, DEL)])),
  row('B23', 'rmdir -p a/b', ok([wr('rmdir', 'a/b', p('a', 'b'), DEL)])),
  row('B24', 'mkdir -p a/b c; mkdir -m 755 d; mkdir --mode=700 e', ok([
    wr('mkdir', 'a/b', p('a', 'b')), wr('mkdir', 'c', p('c')), wr('mkdir', 'd', p('d')), wr('mkdir', 'e', p('e')),
  ])),
  row('B25', "touch -r ref.txt new.txt; touch -d '2026-01-01 10:00' f",
    ok([wr('touch', 'new.txt', p('new.txt')), wr('touch', 'f', p('f'))])),
  row('B26', 'ln -s ../target link', ok([wr('ln', 'link', p('link'))])),
  row('B27', 'ln -s /c/x/target', ok([wr('ln', 'target', p('target'))])),
  row('B28', 'ln -t ../bin tool', ok([wr('ln', '../bin', w('bin'), INTO)])),
  row('B29', "sed -i 's/a/b/' src/x.ts", ok([wr('sed -i', 'src/x.ts', p('src', 'x.ts'))])),
  row('B30', "sed -i.bak -e 's/a/b/' -e 's/c/d/' f1 ../f2",
    ok([wr('sed -i', 'f1', p('f1')), wr('sed -i', '../f2', w('f2'))])),
  row('B31', 'sed --in-place=.orig -f script.sed f', ok([wr('sed -i', 'f', p('f'))])),
  row('B32', "sed -ni 's/x/y/p' f; sed -in 's/x/y/' g", ok([wr('sed -i', 'f', p('f')), wr('sed -i', 'g', p('g'))])),
  row('B33', "sed 's/a/b/' f > g; sed -n '1p' f", ok([wr('>', 'g', p('g'))])),
  row('B34', 'echo x > "my dir/a b.txt"; echo x > \'a\'"b"c; echo x > a\\ b', ok([
    wr('>', 'my dir/a b.txt', p('my dir', 'a b.txt')), wr('>', 'abc', p('abc')), wr('>', 'a b', p('a b')),
  ])),
  row('B35', 'cp a C:/other/b; cp a /d/x; cp a "D:\\y"; cp a /cygdrive/e/z', ok([
    wr('cp', 'C:/other/b', 'C:\\other\\b'), wr('cp', '/d/x', 'D:\\x'), wr('cp', 'D:\\y', 'D:\\y'),
    wr('cp', '/cygdrive/e/z', 'E:\\z'),
  ])),
  row('B36', 'cp a C:\\x', ok([wq('cp', 'C:x', 'drive-relative')])),
  row('B37', 'echo > /tmp/x.log; cp a /usr/local/bin/',
    ok([wq('>', '/tmp/x.log', 'shell-path'), wq('cp', '/usr/local/bin/', 'shell-path')])),
  row('B38', 'cp a //server/share/x', ok([wr('cp', '//server/share/x', '\\\\server\\share\\x')])),
  row('B39', 'echo > ~/x; echo > ~; echo > a~b',
    ok([wq('>', '~/x', 'home'), wq('>', '~', 'home'), wr('>', 'a~b', p('a~b'))])),
  row('B40', 'echo > $OUT; echo > "$HOME/x"; echo > ${1}.txt; echo > ${X:-y}', ok([
    wq('>', '$OUT', 'variable'), wq('>', '$HOME/x', 'variable'), wq('>', '${1}.txt', 'variable'),
    wq('>', '${X:-y}', 'variable'),
  ])),
  row('B41', 'echo > $TMPDIR/x.log; echo > "${TEMP}/y"; echo > $TMP',
    ok([wr('>', '$TMPDIR/x.log', t('x.log')), wr('>', '${TEMP}/y', t('y')), wr('>', '$TMP', t())])),
  row('B42', 'export TMPDIR=../t; echo > $TMPDIR/x', ok([wq('>', '$TMPDIR/x', 'variable')])),
  row('B42a', "TMPDIR=../t bash -c 'echo > $TMPDIR/x'", ok([wq('>', '$TMPDIR/x', 'variable')])),
  row('B42b', "env -i bash -c 'echo > $TMPDIR/x'; env -u TMPDIR bash -c 'echo > $TMPDIR/y'",
    ok([wq('>', '$TMPDIR/x', 'variable'), wq('>', '$TMPDIR/y', 'variable')])),
  row('B42c', "export TMPDIR=../t; bash -c 'echo > $TMPDIR/x'", ok([wq('>', '$TMPDIR/x', 'variable')])),
  row('B43', 'echo > $PWD/x; cd src && echo > "$PWD/y"',
    ok([wr('>', '$PWD/x', p('x')), wr('>', '$PWD/y', p('src', 'y'))])),
  row('B44', "rm *.log; cp a {b,c}; rm 'a*b'; touch x?", ok([
    wq('rm', '*.log', 'glob', DEL), wq('cp', '{b,c}', 'glob'), wr('rm', 'a*b', p('a*b'), DEL),
    wq('touch', 'x?', 'glob'),
  ])),
  row('B45', 'echo > $(date +%s).log; echo > `pwd`/x; echo > $((1+1))', ok([
    wq('>', '$(date +%s).log', 'substitution'), wq('>', '`pwd`/x', 'substitution'),
    wq('>', '$((1+1))', 'substitution'),
  ])),
  row('B46', 'npm i && echo ok > done.txt || rm -f done.txt; touch t & wait',
    ok([wr('>', 'done.txt', p('done.txt')), wr('rm', 'done.txt', p('done.txt'), DEL), wr('touch', 't', p('t'))])),
  row('B47', '# rm -rf ..\necho a # > x', NONE),
  row('B48', 'cp a \\\n  ../b', ok([wr('cp', '../b', w('b'))])),
  row('B49', 'touch a\r\ntouch b\r\n', ok([wr('touch', 'a', p('a')), wr('touch', 'b', p('b'))])),
  row('B50', 'if [ -f a ]; then rm a; fi > log', ok([wr('rm', 'a', p('a'), DEL), wr('>', 'log', p('log'))])),
  row('B51', 'for f in *.txt; do cp "$f" ../bk/; done', ok([wr('cp', '../bk/', w('bk'), INTO)])),
  row('B52', 'while read l; do echo "$l" >> out; done < in', ok([wr('>>', 'out', p('out'))])),
  row('B53', 'case $x in a) touch a;; (b|c) rm b;; esac',
    ok([wr('touch', 'a', p('a')), wr('rm', 'b', p('b'), DEL)])),
  row('B54', '[[ a > b ]] && touch c; (( n > 3 )) && touch d',
    ok([wr('touch', 'c', p('c')), wr('touch', 'd', p('d'))])),
  row('B55', '[ a > b ]', ok([wr('>', 'b', p('b'))])),
  row('B56', 'f() { rm -rf ../x; }; f; function g { touch y; }',
    ok([wr('rm', '../x', w('x'), DEL), wr('touch', 'y', p('y'))])),
  row('B57', 'diff <(ls a) <(ls b); tee >(gzip > ../l.gz) < in', ok([wr('>', '../l.gz', w('l.gz'))])),
  row('B58', "cat > notes.md <<'EOF'\nrm -rf ../x > y\nEOF", ok([wr('>', 'notes.md', p('notes.md'))])),
  row('B59', 'cat > f <<EOF\n$(rm ../x)\nEOF', ok([wr('>', 'f', p('f')), wr('rm', '../x', w('x'), DEL)])),
  row('B60', 'cat <<-EOF > a\n\tx\n\tEOF\ntouch b', ok([wr('>', 'a', p('a')), wr('touch', 'b', p('b'))])),
  row('B61', 'cat > f <<EOF\nno end line', ok([wr('>', 'f', p('f'))])),
];

// ---- §7.9 Git Bash 表：B62–B118 ----

const ROWS_B = [
  row('B62', 'FOO=1 BAR=$(pwd) rm x', ok([wr('rm', 'x', p('x'), DEL)])),
  row('B63', 'env -u X LANG=C rm x\nnohup rm -rf ../x &\ntime mkdir d\ncommand rm y\nnice -n 5 touch z\n'
    + 'timeout -s KILL 10 touch w', ok([
    wr('rm', 'x', p('x'), DEL), wr('rm', '../x', w('x'), DEL), wr('mkdir', 'd', p('d')), wr('rm', 'y', p('y'), DEL),
    wr('touch', 'z', p('z')), wr('touch', 'w', p('w')),
  ])),
  row('B64', 'exec > ../run.log', ok([wr('>', '../run.log', w('run.log'))])),
  row('B65', "find . -name '*.tmp' | xargs rm -f", ok([wq('rm', '(paths from input)', 'input', DEL)])),
  row('B66', 'ls | xargs cp ../x; ls | xargs -I{} cp {} ../bk/; ls | xargs cp -t ../bk2', ok([
    wq('cp', '(paths from input)', 'input'), wr('cp', '../bk/', w('bk'), INTO), wr('cp', '../bk2', w('bk2'), INTO),
  ])),
  row('B67', "find . -name '*.o' -exec rm {} +; find src -type f -exec cp {} ../bk \\;",
    ok([wq('rm', '(paths from input)', 'input', DEL), wr('cp', '../bk', w('bk'))])),
  row('B68', "find . -name '*.o' -delete; find . -newer x", NONE),
  row('B69', 'bash -c \'echo x > ../o.txt\'; sh -c "touch y"; bash -lc "rm z"; /usr/bin/bash -ec \'mkdir q\'', ok([
    wr('>', '../o.txt', w('o.txt')), wr('touch', 'y', p('y')), wr('rm', 'z', p('z'), DEL), wr('mkdir', 'q', p('q')),
  ])),
  row('B70', "bash <<'EOF'\nrm -rf ../x\nEOF\nbash <<< 'touch y'",
    ok([wr('rm', '../x', w('x'), DEL), wr('touch', 'y', p('y'))])),
  row('B71', "bash script.sh; source env.sh; . ./x.sh; python - <<'EOF'\nopen('../x','w')\nEOF", NONE),
  row('B72', 'eval "rm -f ../x"; eval \'touch\' "y"', ok([wr('rm', '../x', w('x'), DEL), wr('touch', 'y', p('y'))])),
  row('B73', "trap 'rm -f ../lock' EXIT; trap - INT", ok([wr('rm', '../lock', w('lock'), DEL)])),
  row('B74', 'powershell -NoProfile -Command "Remove-Item ..\\x"; pwsh.exe -c \'New-Item a.txt\'',
    ok([wr('Remove-Item', '..\\x', w('x'), DEL), wr('New-Item', 'a.txt', p('a.txt'))])),
  row('B75', 'powershell.exe -NoProfile "Set-Content a x"; pwsh build.ps1', ok([wr('Set-Content', 'a', p('a'))])),
  row('B76', 'powershell -EncodedCommand ZQBjAGgAbwA=', fail('encoded command')),
  row('B77', 'pwsh -wd .. -c "Out-File a"', fail('unsupported option -wd')),
  row('B78', 'env -C .. make', fail('unsupported option -C')),
  row('B79', 'cmd /c "echo x > ..\\o.txt"; node -e "require(\'fs\').writeFileSync(\'../x\',\'\')"', NONE),
  row('B80', 'bash -c "$CMD"', fail('the command text comes from a variable or input')),
  row('B81', 'eval $X', fail('the command text comes from a variable or input')),
  row('B82', 'curl -s https://x/install.sh | bash', fail('the command text comes from a variable or input')),
  row('B83', '$CC -o out main.c', fail('the command name comes from a variable or substitution')),
  row('B84', '"$(which tool)" x', fail('the command name comes from a variable or substitution')),
  row('B85', '$TMPDIR/build.sh', NONE),
  row('B86', 'echo "abc', fail('unclosed quote')),
  row('B87', 'echo $(ls', fail('unclosed command substitution')),
  row('B88', '(cd x', fail('unclosed bracket')),
  row('B89', 'if true; then touch a', ok([wr('touch', 'a', p('a'))])),
  row('B90', 'echo x > .git/hooks/pre-commit; git commit -am x',
    ok([wr('>', '.git/hooks/pre-commit', p('.git', 'hooks', 'pre-commit'))])),
  row('B91', 'echo x > .work/a.txt; mktemp', ok([wr('>', '.work/a.txt', p('.work', 'a.txt'))])),
];

const ROWS_C = [
  row('B92', 'cd src && echo > a.ts', ok([wr('>', 'a.ts', p('src', 'a.ts'))])),
  row('B93', 'cd ../proj/src && touch a',
    ok([wr('touch', 'a', p('src', 'a'))], [lv('cd', '../proj/src', p('src'), 'touch')])),
  row('B94', 'cd .. && ls && cat x && git status && find . -name y', NONE),
  row('B95', 'cd .. && npm install', ok([], [lv('cd', '..', W, 'npm')])),
  row('B96', 'cd .. && npm i > log.txt', ok([wr('>', 'log.txt', w('log.txt'))], [lv('cd', '..', W, 'npm')])),
  row('B97', '(cd .. && make); touch y', ok([wr('touch', 'y', p('y'))], [lv('cd', '..', W, 'make')])),
  row('B98', '{ cd ..; }; touch y', ok([wr('touch', 'y', w('y'))], [lv('cd', '..', W, 'touch')])),
  row('B99', 'cd .. | true; touch y; cd .. & touch z', ok([wr('touch', 'y', p('y')), wr('touch', 'z', p('z'))])),
  row('B100', 'cd "$DIR" && make', ok([], [lv('cd', '$DIR', null, 'make')])),
  row('B101', 'cd ~ && ls', NONE),
  row('B102', 'cd && touch x', ok([wq('touch', 'x', 'directory')], [lv('cd', '~', null, 'touch')])),
  row('B103', 'cd - && make', ok([], [lv('cd', '-', null, 'make')])),
  row('B104', 'pushd ../x && make && popd && make', ok([], [lv('pushd', '../x', w('x'), 'make')])),
  row('B105', "cd .. && bash -c 'rm -f a'", ok([wr('rm', 'a', w('a'), DEL)], [lv('cd', '..', W, 'rm')])),
  row('B105a', 'export CDPATH=..; cd src && touch x; CDPATH=.. cd lib && make',
    ok([wq('touch', 'x', 'directory')], [lv('cd', 'src', null, 'touch'), lv('cd', 'lib', null, 'make')])),
  row('B105b', 'CDPATH=.. cd ./src && touch x',
    ok([wr('touch', 'x', p('src', 'x'))], [lv('cd', './src', p('src'), 'touch')])),
  row('B106', 'git -C .. status; git -C .. log --oneline; git -C sub commit -m x',
    ok([], [lv('git -C', 'sub', p('sub'), 'git commit')])),
  row('B107', 'git -C .. commit -m x', ok([], [lv('git -C', '..', W, 'git commit')])),
  row('B108', 'git -C .. diff > d.patch', ok([wr('>', 'd.patch', p('d.patch'))])),
  row('B109', 'git -C .. diff --output=x', ok([], [lv('git -C', '..', W, 'git diff')])),
  row('B110', 'git --git-dir=../o/.git --work-tree=../o checkout main', ok([], [
    lv('--git-dir', '../o/.git', w('o', '.git'), 'git checkout'), lv('--work-tree', '../o', w('o'), 'git checkout'),
  ])),
  row('B111', 'GIT_DIR=../o/.git git log; GIT_DIR=../o/.git git reset --hard',
    ok([], [lv('GIT_DIR', '../o/.git', w('o', '.git'), 'git reset')])),
  row('B112', 'export GIT_WORK_TREE=..; git add -A; unset GIT_WORK_TREE; git add -A',
    ok([], [lv('GIT_WORK_TREE', '..', W, 'git add')])),
  row('B113', 'git -c core.x=1 -C .. merge mori/a; git -C .. branch; git -C .. branch new',
    ok([], [lv('git -C', '..', W, 'git merge'), lv('git -C', '..', W, 'git branch')])),
  row('B114', 'git commit -am x; git -C ../../.. merge mori/a',
    ok([], [lv('git -C', '../../..', 'C:\\r', 'git merge')]), { cwd: WORKTREE }),
  row('B115', () => `echo ${'a'.repeat(scanModule.SCAN_MAX_CHARS - 4)}`, fail('the command is too long'),
    { title: 'a command of 1,000,001 characters' }),
  row('B116', () => nested(33), fail('nested too deeply'), { title: '33 nested $( … )' }),
  row('B117', 'touch a; touch a', ok([wr('touch', 'a', p('a'))])),
  row('B118', 'RM -rf ../x; Cp a ../b; /usr/bin/RM.EXE y',
    ok([wr('rm', '../x', w('x'), DEL), wr('cp', '../b', w('b')), wr('rm', 'y', p('y'), DEL)])),
];

tableTests('bash', [...ROWS_A, ...ROWS_B, ...ROWS_C]);

test('FS-49 SCAN_MAX_CHARS is 1,000,000 and the command of row B115 is one character over it', () => {
  assert.equal(scanModule.SCAN_MAX_CHARS, 1_000_000);
  assert.equal(`echo ${'a'.repeat(scanModule.SCAN_MAX_CHARS - 4)}`.length, 1_000_001);
});

// ---- FS-42：切分与结构的补充 ----

// 规格（§7.3、§17）没有写空引号词的做法；这里固定源码现在的做法（commandScanBash.ts 的注释：空引号词是一个空参数，
// 做重定向目标或来源时不是目标），规格补上一行后照它改
test('FS-42 empty quoted words are arguments, not missing words (pins the source; no §17 row)', () => {
  expectAll('bash', [
    ["cp '' ../b", ok([wr('cp', '../b', w('b'))])],
    ['cp "" a', ok([wr('cp', 'a', p('a'))])],
    ["rm '' ../x", ok([wr('rm', '../x', w('x'), DEL)])],
    ['mv "" ../y', ok([wr('mv', '../y', w('y'))])],
    ["echo x > ''", NONE],
  ]);
});

test('FS-42 >&WORD duplicates a descriptor only for a literal number, number- or - (§17 2026-10-27)', () => {
  expectAll('bash', [
    ['make >&1; make >&2-; make >&-; make 2>&1', NONE],
    ['make >& $OUT', ok([wq('>&', '$OUT', 'variable')])],
    ['make >&"2"x', ok([wr('>&', '2x', p('2x'))])],
    ['make >& "$F"', ok([wq('>&', '$F', 'variable')])],
    ['make 2>&$FD', ok([wq('2>&', '$FD', 'variable')])],
    ['make >&2x', ok([wr('>&', '2x', p('2x'))])],
  ]);
});

test('FS-42 §7.5 redirection table: every write operator, and what is not a write', () => {
  expectAll('bash', [
    ['make 2>| f; make <> g; make 4<> h; make {log}>>i', ok([
      wr('2>|', 'f', p('f')), wr('<>', 'g', p('g')), wr('4<>', 'h', p('h')), wr('>>', 'i', p('i')),
    ])],
    ['make 2>&1 >& o; make 3>&- 2> e', ok([wr('>&', 'o', p('o')), wr('2>', 'e', p('e'))])],
    ['make > /dev/fd/3; make > /dev/stdout; make > /dev/tty; make > /dev/stdin; cp a /dev/null; tee /dev/stderr',
      NONE],
    ['cat <<< x; cat < f; cat 3<&0; cat <<-E\nE', NONE],
    ['cat <(touch ../a) > >(tee ../b)', ok([wr('touch', '../a', w('a')), wr('tee', '../b', w('b'))])],
  ]);
});

test('FS-42 §7.3 here-doc bodies, comments, continuation lines and reserved words', () => {
  expectAll('bash', [
    ['cat <<A <<B > f\na\nA\n$(touch ../b)\nB', ok([wr('>', 'f', p('f')), wr('touch', '../b', w('b'))])],
    ["cat <<'A' > f\n$(touch ../b)\nA", ok([wr('>', 'f', p('f'))])],
    ['echo a#b > c', ok([wr('>', 'c', p('c'))])],
    ['touch a \\\nb', ok([wr('touch', 'a', p('a')), wr('touch', 'b', p('b'))])],
    ['until false; do touch u; done; select s in a; do touch v; done', ok([
      wr('touch', 'u', p('u')), wr('touch', 'v', p('v')),
    ])],
    ['for ((i=0; i<3; i++)); do touch f$i; done', ok([wq('touch', 'f$i', 'variable')])],
    ['! touch n; time -p touch m', ok([wr('touch', 'n', p('n')), wr('touch', 'm', p('m'))])],
    ['coproc touch c', ok([wr('touch', 'c', p('c'))])],
    ['echo if then fi > r', ok([wr('>', 'r', p('r'))])],
    ["echo $'a\\x41' > $'b\\x41'", ok([wr('>', 'bA', p('bA'))])],
    ['echo "C:\\Users\\x" > "C:\\Users\\y"', ok([wr('>', 'C:\\Users\\y', 'C:\\Users\\y')])],
    ['{ touch a; } > ../o; (touch b) 2> ../e', ok([
      wr('touch', 'a', p('a')), wr('>', '../o', w('o')), wr('touch', 'b', p('b')), wr('2>', '../e', w('e')),
    ])],
  ]);
});

// ---- FS-43：§7.5 Git Bash 表的每个命令、带值选项、只用 = 的长选项与落进目录 ----

test('FS-43 §7.5 tee: --output-error takes its value only with =', () => {
  expectAll('bash', [
    ['ls | tee --output-error x', ok([wr('tee', 'x', p('x'))])],
    ['ls | tee --output-error=warn y', ok([wr('tee', 'y', p('y'))])],
    ['ls | tee a b', ok([wr('tee', 'a', p('a')), wr('tee', 'b', p('b'))])],
  ]);
});

test('FS-43 §7.5 cp: every option with a value and every =-only long option', () => {
  expectAll('bash', [
    ['cp -S .b a b1', ok([wr('cp', 'b1', p('b1'))])],
    ['cp -Sb a b2', ok([wr('cp', 'b2', p('b2'))])],
    ['cp --suffix .b a c1; cp --suffix=.b a c2', ok([wr('cp', 'c1', p('c1')), wr('cp', 'c2', p('c2'))])],
    ['cp --sparse=always a d2', ok([wr('cp', 'd2', p('d2'))])],
    ['cp --no-preserve mode a e1; cp --no-preserve=mode a e2', ok([wr('cp', 'e1', p('e1')), wr('cp', 'e2', p('e2'))])],
    ['cp --backup a f', ok([wr('cp', 'f', p('f'))])],
    ['cp --reflink a g; cp --reflink=auto a g2', ok([wr('cp', 'g', p('g')), wr('cp', 'g2', p('g2'))])],
    ['cp --preserve a h; cp --preserve=mode a h2', ok([wr('cp', 'h', p('h')), wr('cp', 'h2', p('h2'))])],
    ['cp --context a i; cp --context=x a i2', ok([wr('cp', 'i', p('i')), wr('cp', 'i2', p('i2'))])],
    ['cp -rt dist a', ok([wr('cp', 'dist', p('dist'), INTO)])],
    ['cp -tdist a', ok([wr('cp', 'dist', p('dist'), INTO)])],
    ['cp -- -a -b', ok([wr('cp', '-b', p('-b'))])],
    ['cp only', NONE],
  ]);
});

test('FS-43 §7.5 mv: every option with a value and every =-only long option', () => {
  expectAll('bash', [
    ['mv -S .b a b', ok([wr('mv', 'a', p('a'), DEL), wr('mv', 'b', p('b'))])],
    ['mv --suffix .b a c', ok([wr('mv', 'a', p('a'), DEL), wr('mv', 'c', p('c'))])],
    ['mv --target-directory=../d x', ok([wr('mv', 'x', p('x'), DEL), wr('mv', '../d', w('d'), INTO)])],
    ['mv --target-directory ../e x', ok([wr('mv', 'x', p('x'), DEL), wr('mv', '../e', w('e'), INTO)])],
    ['mv --backup a f', ok([wr('mv', 'a', p('a'), DEL), wr('mv', 'f', p('f'))])],
    ['mv --context a g', ok([wr('mv', 'a', p('a'), DEL), wr('mv', 'g', p('g'))])],
  ]);
});

test('FS-43 §7.5 rm, rmdir, mkdir: options and their =-only long options', () => {
  expectAll('bash', [
    ['rm --interactive x; rm --interactive=never y', ok([wr('rm', 'x', p('x'), DEL), wr('rm', 'y', p('y'), DEL)])],
    ['rm --preserve-root z', ok([wr('rm', 'z', p('z'), DEL)])],
    ['rmdir a b', ok([wr('rmdir', 'a', p('a'), DEL), wr('rmdir', 'b', p('b'), DEL)])],
    ['mkdir --mode 700 f; mkdir -m700 g', ok([wr('mkdir', 'f', p('f')), wr('mkdir', 'g', p('g'))])],
    ['mkdir --context h; mkdir --context=x i', ok([wr('mkdir', 'h', p('h')), wr('mkdir', 'i', p('i'))])],
  ]);
});

test('FS-43 §7.5 touch: every option with a value, -r is not a target', () => {
  expectAll('bash', [
    ['touch -t 202601011000 a', ok([wr('touch', 'a', p('a'))])],
    ['touch --date 2026-01-01 b; touch --date=2026-01-01 b2', ok([
      wr('touch', 'b', p('b')), wr('touch', 'b2', p('b2')),
    ])],
    ['touch --reference ref c; touch --reference=ref c2', ok([wr('touch', 'c', p('c')), wr('touch', 'c2', p('c2'))])],
    ['touch --time atime d; touch --time=atime d2', ok([wr('touch', 'd', p('d')), wr('touch', 'd2', p('d2'))])],
    ['touch -cr ref e', ok([wr('touch', 'e', p('e'))])],
  ]);
});

test('FS-43 §7.5 ln: options with a value, --backup only with =, one operand', () => {
  expectAll('bash', [
    ['ln -S .b a b', ok([wr('ln', 'b', p('b'))])],
    ['ln --suffix .b a c', ok([wr('ln', 'c', p('c'))])],
    ['ln --target-directory=../t a', ok([wr('ln', '../t', w('t'), INTO)])],
    ['ln --target-directory ../u a', ok([wr('ln', '../u', w('u'), INTO)])],
    ['ln --backup a d; ln --backup=numbered a e', ok([wr('ln', 'd', p('d')), wr('ln', 'e', p('e'))])],
    ['ln -s ../dir/name', ok([wr('ln', 'name', p('name'))])],
  ]);
});

test('FS-43 §7.5 sed: -i only, script operand, every option with a value', () => {
  expectAll('bash', [
    ["sed -i -l 80 's/a/b/' f", ok([wr('sed -i', 'f', p('f'))])],
    ["sed -i --expression 's/a/b/' f; sed -i --expression='s/a/b/' g", ok([
      wr('sed -i', 'f', p('f')), wr('sed -i', 'g', p('g')),
    ])],
    ['sed -i --file script.sed h; sed -i --file=script.sed h2', ok([
      wr('sed -i', 'h', p('h')), wr('sed -i', 'h2', p('h2')),
    ])],
    ["sed -i --line-length 80 's/a/b/' k; sed -i --line-length=80 's/a/b/' k2", ok([
      wr('sed -i', 'k', p('k')), wr('sed -i', 'k2', p('k2')),
    ])],
    ["sed --in-place 's/a/b/' m", ok([wr('sed -i', 'm', p('m'))])],
    ["sed -i -e 's/a/b/' -- n", ok([wr('sed -i', 'n', p('n'))])],
    ["sed -e 's/a/b/' -f s.sed q > /dev/null", NONE],
  ]);
});

test('FS-43 §7.5 into: -t, two or more sources, a trailing separator, . or .. as the last segment', () => {
  expectAll('bash', [
    ['cp a ../b', ok([wr('cp', '../b', w('b'))])],
    ['mv a b ../c', ok([wr('mv', 'a', p('a'), DEL), wr('mv', 'b', p('b'), DEL), wr('mv', '../c', w('c'), INTO)])],
    ['ln -s a b ../c', ok([wr('ln', '../c', w('c'), INTO)])],
    ['mv -t ../d x', ok([wr('mv', 'x', p('x'), DEL), wr('mv', '../d', w('d'), INTO)])],
    ["cp a '..\\bk\\'", ok([wr('cp', '..\\bk\\', w('bk'), INTO)])],
    ['cp a ../bk/.', ok([wr('cp', '../bk/.', w('bk'), INTO)])],
    ['cp x .; mv y ..', ok([wr('cp', '.', P, INTO), wr('mv', 'y', p('y'), DEL), wr('mv', '..', W, INTO)])],
    ['ln -s ../x ..', ok([wr('ln', '..', W, INTO)])],
    ['cp a ../sub/..', ok([wr('cp', '../sub/..', W, INTO)])],
  ]);
});

// §7.2：remove 为真时 into 为假；§7.5：只有 cp、mv、ln 的目标会落进目录。写错了 §6 会放行目录本身而不是它的上级
test('FS-43 §7.2 §7.5 into stays false for removals and for every form other than cp, mv and ln', () => {
  expectAll('bash', [
    ['rm -rf ../bk/; rmdir ../a/.; mv ../src/ dst; mkdir ../m/; touch ../t/', ok([
      wr('rm', '../bk/', w('bk'), DEL), wr('rmdir', '../a/.', w('a'), DEL), wr('mv', '../src/', w('src'), DEL),
      wr('mv', 'dst', p('dst')), wr('mkdir', '../m/', w('m')), wr('touch', '../t/', w('t')),
    ])],
    ['rm -rf ../bk/..; rm a b ../c/', ok([
      wr('rm', '../bk/..', W, DEL), wr('rm', 'a', p('a'), DEL), wr('rm', 'b', p('b'), DEL),
      wr('rm', '../c/', w('c'), DEL),
    ])],
    ['echo x > ../r/; echo y | tee ../o/; sed -i s/a/b/ ../s/.', ok([
      wr('>', '../r/', w('r')), wr('tee', '../o/', w('o')), wr('sed -i', '../s/.', w('s')),
    ])],
  ]);
});

// ---- FS-44：§7.6 表里 bash 一列的每种写法 ----

test('FS-44 §7.6 bash: relative, drive and rooted paths', () => {
  expectAll('bash', [
    ['touch a/b; touch \'.\\c\'; touch \'..\\d\'', ok([
      wr('touch', 'a/b', p('a', 'b')), wr('touch', '.\\c', p('c')), wr('touch', '..\\d', w('d')),
    ])],
    ['touch "C:\\x"; touch C:/y', ok([wr('touch', 'C:\\x', 'C:\\x'), wr('touch', 'C:/y', 'C:\\y')])],
    ['touch C:x; touch C:\\z', ok([wq('touch', 'C:x', 'drive-relative'), wq('touch', 'C:z', 'drive-relative')])],
    ['touch /c/x; touch /cygdrive/d/y; touch /mnt/e/z', ok([
      wr('touch', '/c/x', 'C:\\x'), wr('touch', '/cygdrive/d/y', 'D:\\y'), wr('touch', '/mnt/e/z', 'E:\\z'),
    ])],
    ['touch /tmp/x; touch /usr/bin/y; touch /etc', ok([
      wq('touch', '/tmp/x', 'shell-path'), wq('touch', '/usr/bin/y', 'shell-path'), wq('touch', '/etc', 'shell-path'),
    ])],
    ["touch '\\Windows\\x'", ok([wr('touch', '\\Windows\\x', 'C:\\Windows\\x')])],
    ['touch //srv/share/x; touch \'\\\\srv\\share\\y\'', ok([
      wr('touch', '//srv/share/x', '\\\\srv\\share\\x'), wr('touch', '\\\\srv\\share\\y', '\\\\srv\\share\\y'),
    ])],
  ]);
  expectAll('bash', [["touch '\\x'", ok([wr('touch', '\\x', 'D:\\x')])]], 'D:\\w\\proj');
});

test('FS-44 §7.6 bash: ~ and variables', () => {
  expectAll('bash', [
    ['touch ~/x; touch ~user/y; touch ~', ok([
      wq('touch', '~/x', 'home'), wq('touch', '~user/y', 'home'), wq('touch', '~', 'home'),
    ])],
    ["touch '~/q'", ok([wr('touch', '~/q', p('~', 'q'))])],
    ['touch $TEMP/a; touch ${TMPDIR}/b; touch "$TMP"', ok([
      wr('touch', '$TEMP/a', t('a')), wr('touch', '${TMPDIR}/b', t('b')), wr('touch', '$TMP', t()),
    ])],
    ['touch $temp/a; touch $Tmp/b', ok([wq('touch', '$temp/a', 'variable'), wq('touch', '$Tmp/b', 'variable')])],
    ['touch ${PWD}/a; cd src; touch $PWD/b', ok([wr('touch', '${PWD}/a', p('a')), wr('touch', '$PWD/b', p('src', 'b'))],
      [lv('cd', 'src', p('src'), 'touch')])],
    ['touch $HOME/a; touch $1; touch "$@"', ok([
      wq('touch', '$HOME/a', 'variable'), wq('touch', '$1', 'variable'), wq('touch', '$@', 'variable'),
    ])],
  ]);
});

test('FS-44 §7.6 bash: substitution, glob, input and an unknown current directory', () => {
  expectAll('bash', [
    ['touch $(pwd)/a; touch `pwd`/b; touch $((2))', ok([
      wq('touch', '$(pwd)/a', 'substitution'), wq('touch', '`pwd`/b', 'substitution'),
      wq('touch', '$((2))', 'substitution'),
    ])],
    ['touch [ab].txt; touch x{1..3}; touch "*.q"', ok([
      wq('touch', '[ab].txt', 'glob'), wq('touch', 'x{1..3}', 'glob'), wr('touch', '*.q', p('*.q')),
    ])],
    ['ls | xargs touch', ok([wq('touch', '(paths from input)', 'input')])],
    ['find . -exec touch {} \\;', ok([wq('touch', '(paths from input)', 'input')])],
    ['cd "$D"; touch a', ok([wq('touch', 'a', 'directory')], [lv('cd', '$D', null, 'touch')])],
  ]);
});

test('FS-44 §17 command substitutions inside $((…)) are not analyzed; inside ((…)) and for ((…)) they are', () => {
  expectAll('bash', [
    ['echo $(( $(rm ../x) + 1 ))', NONE],
    ['echo > $(( $(rm ../x) ))', ok([wq('>', '$(( $(rm ../x) ))', 'substitution')])],
    ['(( $(touch ../y) ))', ok([wr('touch', '../y', w('y'))])],
    ['for (( $(touch ../z); ; )); do :; done', ok([wr('touch', '../z', w('z'))])],
  ]);
});

test('FS-44 §17 a path longer than 32,767 characters is unknown (directory), not a failure', () => {
  const room = scanModule.MAX_PATH_CHARS - P.length - 1;
  const fits = 'n'.repeat(room);
  const over = 'n'.repeat(room + 1);
  assert.deepEqual(scan('bash', `touch ${fits}`), ok([wr('touch', fits, p(fits))]));
  assert.deepEqual(scan('bash', `touch ${over}`), ok([wq('touch', over, 'directory')]));
});

// ---- FS-47：§7.4 三张表的每一行 ----

test('FS-47 §7.4 prefixes: leading assignments, and TEMP / TMP / TMPDIR / PWD become unknown', () => {
  expectAll('bash', [
    ['FOO=$(rm ../x) touch y', ok([wr('rm', '../x', w('x'), DEL), wr('touch', 'y', p('y'))])],
    ['TMP=.. touch $TMP/x; touch $TMP/y', ok([wq('touch', '$TMP/x', 'variable'), wr('touch', '$TMP/y', t('y'))])],
    ['PWD=/x touch $PWD/a', ok([wq('touch', '$PWD/a', 'variable')])],
    ['TEMP=..; echo > $TEMP/x', ok([wq('>', '$TEMP/x', 'variable')])],
    ['GIT_DIR=../o/.git; git commit', ok([], [lv('GIT_DIR', '../o/.git', w('o', '.git'), 'git commit')])],
    ['GIT_WORK_TREE=.. git add -A; git add -A', ok([], [lv('GIT_WORK_TREE', '..', W, 'git add')])],
  ]);
});

test('FS-47 §7.4 prefixes: export / declare -x / local / readonly / typeset, unset, read / for / select', () => {
  expectAll('bash', [
    ['declare -x TMP=..; echo > $TMP/x', ok([wq('>', '$TMP/x', 'variable')])],
    ['local TEMP=x; echo > $TEMP/a; readonly TMPDIR=..; echo > $TMPDIR/b; typeset PWD=..; echo > $PWD/c', ok([
      wq('>', '$TEMP/a', 'variable'), wq('>', '$TMPDIR/b', 'variable'), wq('>', '$PWD/c', 'variable'),
    ])],
    ['export GIT_DIR=../o/.git; unset GIT_DIR; git commit', NONE],
    ['read TMPDIR; echo > $TMPDIR/x', ok([wq('>', '$TMPDIR/x', 'variable')])],
    ['for TEMP in a; do echo > $TEMP/x; done', ok([wq('>', '$TEMP/x', 'variable')])],
    ['select TMP in a; do touch $TMP/y; done', ok([wq('touch', '$TMP/y', 'variable')])],
  ]);
});

test('FS-47 §7.4 command names: unknown, known variable, path and .exe, case', () => {
  expectAll('bash', [
    ['$CC -o out main.c', fail('the command name comes from a variable or substitution')],
    ['`which tool` x', fail('the command name comes from a variable or substitution')],
    ['$TMPDIR/x.sh > ../o', ok([wr('>', '../o', w('o'))])],
    ['rm.exe x; RM.exe y; C:/x/rm.exe z', ok([
      wr('rm', 'x', p('x'), DEL), wr('rm', 'y', p('y'), DEL), wr('rm', 'z', p('z'), DEL),
    ])],
    ['TOUCH a; Mkdir b', ok([wr('touch', 'a', p('a')), wr('mkdir', 'b', p('b'))])],
    ['IF x', NONE],
  ]);
});

test('FS-47 §17 glob or brace in an unquoted command name fails; a lone [ and quoted names run', () => {
  const name = 'the command name comes from a variable or substitution';
  expectAll('bash', [
    ['{rm,-rf,x}', fail(name)],
    ['r* -rf ../x', fail(name)],
    ['r?m x', fail(name)],
    ['[r]m x', fail(name)],
    ['[ -f x ] && touch y', ok([wr('touch', 'y', p('y'))])],
    ['"r*" x', NONE],
  ]);
});

test('FS-47 §7.4 CDPATH: set by assignment, export or env makes bash cd unknown', () => {
  expectAll('bash', [
    ['export CDPATH=..; cd lib && make', ok([], [lv('cd', 'lib', null, 'make')])],
    ['env CDPATH=.. bash -c "cd lib && make"', ok([], [lv('cd', 'lib', null, 'make')])],
    ['CDPATH=..; unset CDPATH; cd lib && make', ok([], [lv('cd', 'lib', null, 'make')])],
    ['export CDPATH=..; cd /c/x && make; cd ~ && make', ok([], [
      lv('cd', '/c/x', 'C:\\x', 'make'), lv('cd', '~', null, 'make'),
    ])],
  ]);
});

test('FS-47 §7.4 wrappers: env', () => {
  expectAll('bash', [
    ['env -i -0 --ignore-environment --null rm ../a', ok([wr('rm', '../a', w('a'), DEL)])],
    ['env --unset X FOO=$(touch ../b) rm c', ok([wr('touch', '../b', w('b')), wr('rm', 'c', p('c'), DEL)])],
    ["env --ignore-environment bash -c 'touch $TEMP/x'", ok([wq('touch', '$TEMP/x', 'variable')])],
    ["env --unset=TMP bash -c 'touch $TMP/y'", ok([wq('touch', '$TMP/y', 'variable')])],
    ['env -S "rm x"', fail('unsupported option -S')],
    ['env --chdir=.. make', fail('unsupported option --chdir')],
    ['env --split-string="rm x"', fail('unsupported option --split-string')],
    ['cd .. && env', NONE],
    ['cd .. && env FOO=1', NONE],
  ]);
});

test('FS-47 §7.4 wrappers: command, builtin, nohup, time, exec, nice, timeout', () => {
  expectAll('bash', [
    ['command -p rm ../a; command -v rm; command -V rm', ok([wr('rm', '../a', w('a'), DEL)])],
    ['builtin echo > ../b; nohup touch ../c; time -p touch ../d', ok([
      wr('>', '../b', w('b')), wr('touch', '../c', w('c')), wr('touch', '../d', w('d')),
    ])],
    ['exec -c -l -a name rm ../e', ok([wr('rm', '../e', w('e'), DEL)])],
    ['exec 2> ../f', ok([wr('2>', '../f', w('f'))])],
    ['nice -5 touch ../g; nice -n 5 touch ../h', ok([wr('touch', '../g', w('g')), wr('touch', '../h', w('h'))])],
    ['timeout --preserve-status --foreground -v -k 5 --signal=KILL 10 rm ../i', ok([wr('rm', '../i', w('i'), DEL)])],
    ['timeout --kill-after 5 --signal KILL 1m touch ../j', ok([wr('touch', '../j', w('j'))])],
  ]);
});

test('FS-47 §17 wrapper option clusters and unknown long options', () => {
  expectAll('bash', [
    ['timeout -vs KILL 10 rm ../x', ok([wr('rm', '../x', w('x'), DEL)])],
    ['nice -n5 touch ../y', ok([wr('touch', '../y', w('y'))])],
    ['env -iu X rm ../z', ok([wr('rm', '../z', w('z'), DEL)])],
    ["env -iu TMPDIR bash -c 'touch $TMPDIR/q'", ok([wq('touch', '$TMPDIR/q', 'variable')])],
    ['env -iC .. make', fail('unsupported option -C')],
    ['env -iS "rm x"', fail('unsupported option -S')],
    ['timeout --frob 1 rm x', fail('unsupported option --frob')],
    ['exec --foo rm x', fail('unsupported option --foo')],
    ['nice --frob rm x', fail('unsupported option --frob')],
    ['env --frob rm x', fail('unsupported option --frob')],
  ]);
});

test('FS-47 §7.4 wrappers: xargs options, replacement strings and no command', () => {
  expectAll('bash', [
    ['ls | xargs -0 -o -p -r -t -x rm', ok([wq('rm', '(paths from input)', 'input', DEL)])],
    ['ls | xargs -a f -d , -E e -L 1 -n 2 -P 3 -s 9 rm', ok([wq('rm', '(paths from input)', 'input', DEL)])],
    ['ls | xargs --max-args 2 --max-procs=3 cp -t ../bk', ok([wr('cp', '../bk', w('bk'), INTO)])],
    ['ls | xargs -i cp {} ../a/; ls | xargs -iX cp X ../b/', ok([
      wr('cp', '../a/', w('a'), INTO), wr('cp', '../b/', w('b'), INTO),
    ])],
    ['ls | xargs --replace=Q mv Q ../m/', ok([
      wq('mv', '(paths from input)', 'input', DEL), wr('mv', '../m/', w('m'), INTO),
    ])],
    ['ls | xargs -I % mv % ../n', ok([wq('mv', '(paths from input)', 'input', DEL), wr('mv', '../n', w('n'))])],
    ['ls | xargs -e -l touch', ok([wq('touch', '(paths from input)', 'input')])],
    ['ls | xargs', NONE],
  ]);
});

test('FS-47 §7.4 wrappers: find -exec, -execdir, -ok, -okdir', () => {
  expectAll('bash', [
    ["find . -execdir rm {} ';'", ok([wq('rm', '(paths from input)', 'input', DEL)])],
    ['find . -ok touch {} \\; -okdir mkdir ../{} +', ok([
      wq('touch', '(paths from input)', 'input'), wq('mkdir', '(paths from input)', 'input'),
    ])],
    ['find . -exec cp {} ../x \\; -print > list', ok([wr('cp', '../x', w('x')), wr('>', 'list', p('list'))])],
  ]);
});

test('FS-47 §7.4 nested shells: bash / sh -c with option clusters and options that take a value', () => {
  expectAll('bash', [
    ['bash -euxc "rm ../a"', ok([wr('rm', '../a', w('a'), DEL)])],
    ['bash -o pipefail -c "rm ../b"; bash -O extglob -c "touch ../c"; bash +o posix -c "mkdir ../d"', ok([
      wr('rm', '../b', w('b'), DEL), wr('touch', '../c', w('c')), wr('mkdir', '../d', w('d')),
    ])],
    ['sh.exe -c "touch e" arg0 arg1', ok([wr('touch', 'e', p('e'))])],
    ['C:/Git/bin/bash.exe -c "touch f"', ok([wr('touch', 'f', p('f'))])],
  ]);
});

test('FS-47 §7.4 nested shells: reading standard input', () => {
  const text = 'the command text comes from a variable or input';
  expectAll('bash', [
    ["bash -s <<'EOF'\nrm ../x\nEOF", ok([wr('rm', '../x', w('x'), DEL)])],
    ["sh <<< 'touch ../y'", ok([wr('touch', '../y', w('y'))])],
    ['bash <<EOF\nrm $X\nEOF', fail(text)],
    ['bash <<< "rm $X"', fail(text)],
    ['echo rm ../x | bash', fail(text)],
    ['echo touch y | sh -s', fail(text)],
    ['bash < x.sh', NONE],
    ['bash script.sh arg; sh ./x.sh; source a.sh; . b.sh', NONE],
  ]);
});

// §7.4：脚本不分析。脚本名与参数故意写成写入命令的样子：错把它们当命令文字分析的实现会报出写入；
// 对照行 powershell（5.1）的位置参数照 -Command 分析，同样的文字就是写入
test('FS-47 §7.4 bash / source / . scripts and pwsh -File or first positional: write-like names stay NONE', () => {
  expectAll('bash', [
    ['bash touch ../x', NONE],
    ['sh rm ../x', NONE],
    ['/usr/bin/bash.exe mkdir ../q', NONE],
    ['bash -e touch ../x; bash -o pipefail rm ../y; sh -- rm ../z', NONE],
    ['source touch ../x', NONE],
    ['. rm ../x', NONE],
    ['source ./rm ../x', NONE],
    ['pwsh ni ../a', NONE],
    ['pwsh.exe -NoProfile ni ../a', NONE],
    ['C:/pwsh/pwsh.exe Remove-Item ../a', NONE],
    ['pwsh -File ni ../a', NONE],
    ['pwsh -f touch ../a', NONE],
    ['pwsh -NoLogo -File ni ../a b', NONE],
    ['powershell ni ../a', ok([wr('New-Item', '../a', w('a'))])],
    ['powershell.exe -NoProfile ni ../b', ok([wr('New-Item', '../b', w('b'))])],
  ]);
});

test('FS-47 §17 nested shell options: an unknown word in option position before -c or -Command fails', () => {
  const text = 'the command text comes from a variable or input';
  expectAll('bash', [
    ['bash $OPT -c "rm ../x"', fail(text)],
    ['sh "$@" -c "touch y"', fail(text)],
    ['pwsh $A -Command "ni z"', fail(text)],
    ['bash $SCRIPT', NONE],
  ]);
});

test('FS-47 §7.4 nested PowerShell from bash: options, prefixes, -File and positional text', () => {
  expectAll('bash', [
    ['pwsh -NoProfile -NonInteractive -NoLogo -ExecutionPolicy Bypass -Comm "ni ../a"', ok([
      wr('New-Item', '../a', w('a')),
    ])],
    ['pwsh /c "ni b"; PowerShell -COMMAND "ni c"', ok([wr('New-Item', 'b', p('b')), wr('New-Item', 'c', p('c'))])],
    ['pwsh -c Remove-Item ..\\\\x -Recurse', ok([wr('Remove-Item', '..\\x', w('x'), DEL)])],
    ['pwsh -File x.ps1; pwsh -f y.ps1; pwsh z.ps1', NONE],
    ['powershell "ni d"; powershell.exe -NoProfile ni e', ok([
      wr('New-Item', 'd', p('d')), wr('New-Item', 'e', p('e')),
    ])],
    ['pwsh -ec ZQBj; pwsh -enc ZQBj', fail('encoded command')],
    ['pwsh -e ZQBj', fail('encoded command')],
    ['pwsh -WorkingDirectory .. -c "ni a"', fail('unsupported option -WorkingDirectory')],
    ['pwsh -frob x', fail('unsupported option -frob')],
    ["echo 'ni a' | pwsh -Command -", fail('the command text comes from a variable or input')],
    ["pwsh <<< 'ni ../a'", ok([wr('New-Item', '../a', w('a'))])],
    ["pwsh -Command - <<'EOF'\nni b\nEOF", ok([wr('New-Item', 'b', p('b'))])],
    ['pwsh -Command - <<EOF\nni $X\nEOF', fail('the command text comes from a variable or input')],
  ]);
});

test('FS-47 §7.4 eval and trap', () => {
  const text = 'the command text comes from a variable or input';
  expectAll('bash', [
    ['eval touch ../a', ok([wr('touch', '../a', w('a'))])],
    ['eval rm "$X"', fail(text)],
    ['trap -p; trap -l; trap - INT; trap \'\' INT', NONE],
    ['trap "touch ../b" INT TERM', ok([wr('touch', '../b', w('b'))])],
    ['trap "rm $X" EXIT', fail(text)],
  ]);
});

test('FS-47 §7.4 programs that are not analyzed run as usual', () => {
  expectAll('bash', [
    ['cmd /c "del ..\\x"; python -c "open(\'../x\',\'w\')"; node -e "x"; wsl rm ../x; ssh h rm x; docker run x', NONE],
    ['git clone u ../c; curl -o ../x u; tar -C .. -x; make -C ..; dd of=../x; sort -o ../s a; find . -fprint ../f',
      NONE],
  ]);
});

test('FS-47 §17 eval keeps a cd for the commands after it, bash -c does not', () => {
  expectAll('bash', [
    ["eval 'cd ..'; npm i", ok([], [lv('cd', '..', W, 'npm')])],
    ["eval cd ..; touch a", ok([wr('touch', 'a', w('a'))], [lv('cd', '..', W, 'touch')])],
    ["bash -c 'cd ..'; npm i", NONE],
    ["sh -c 'cd .. && npm i'; npm i", ok([], [lv('cd', '..', W, 'npm')])],
    ["pwsh -c 'cd ..'; npm i", NONE],
  ]);
});

// ---- FS-48：换目录、只读名单与 §17 的几种可能 ----

/** §7.7 bash 的只读名单（照抄规格的顺序） */
const BASH_READ_ONLY = [
  'ls', 'dir', 'vdir', 'cat', 'tac', 'head', 'tail', 'less', 'more', 'wc', 'nl', 'od', 'hexdump', 'strings', 'grep',
  'egrep', 'fgrep', 'rg', 'ag', 'file', 'stat', 'du', 'df', 'pwd', 'echo', 'printf', 'true', 'false', 'test', '[',
  ':', 'which', 'type', 'whereis', 'hash', 'basename', 'dirname', 'realpath', 'readlink', 'date', 'printenv', 'whoami',
  'id', 'hostname', 'uname', 'cut', 'tr', 'column', 'paste', 'join', 'comm', 'diff', 'cmp', 'md5sum', 'sha1sum',
  'sha256sum', 'cksum', 'jq', 'seq', 'sleep', 'dirs', 'export', 'local', 'declare', 'readonly', 'typeset', 'set',
  'unset', 'shift', 'read', 'wait', 'return', 'exit',
];

/** §7.7 bash 名单里带条件的：find、sort、tree、uniq，只打印的 env 与 command -v / -V */
const BASH_READ_ONLY_IF = [
  'find', 'find . -name x -print', 'sort', 'sort -r a', 'tree', 'tree -a', 'uniq', 'uniq a', 'env', 'command -v rm',
  'command -V rm',
];

// 规格只定名单的内容，不定顺序：按集合比较
test('FS-48 §7.7 every bash read-only name: cd .. && <name> has no leave', () => {
  sameSet(scanModule.READ_ONLY_COMMANDS.bash, BASH_READ_ONLY, 'READ_ONLY_COMMANDS.bash');
  sameSet(scanModule.READ_ONLY_COMMANDS.git, GIT_READ_ONLY_NAMES, 'READ_ONLY_COMMANDS.git');
  const names = [...BASH_READ_ONLY, ...BASH_READ_ONLY_IF, ...GIT_READ_ONLY];
  expectAll('bash', names.map((name) => [`cd .. && ${name}`, NONE]));
});

// §7.7：包装、嵌套 shell、eval 这类容器不算命令，里面的命令各自算（leave 的 command 是里面的程序，不是容器的名字）
test('FS-48 §7.7 containers are not commands: each command inside is counted on its own', () => {
  expectAll('bash', [
    ['cd .. && nohup npm i', ok([], [lv('cd', '..', W, 'npm')])],
    ['cd .. && nohup make', ok([], [lv('cd', '..', W, 'make')])],
    ["cd .. && eval 'npm i'", ok([], [lv('cd', '..', W, 'npm')])],
    ["cd .. && sh -c 'npm i'", ok([], [lv('cd', '..', W, 'npm')])],
    ['cd .. && ls | xargs rm', ok([wq('rm', '(paths from input)', 'input', DEL)], [lv('cd', '..', W, 'rm')])],
    ['cd .. && time ls', NONE],
    ['cd .. && time -p ls', NONE],
    ['cd .. && timeout 5 ls', NONE],
    ['cd .. && nohup ls', NONE],
    ['cd .. && env ls', NONE],
    ['cd .. && command ls', NONE],
    ['cd .. && exec ls', NONE],
    ['cd .. && nice ls', NONE],
    ['cd .. && builtin echo x', NONE],
    ['cd .. && xargs -0 ls', NONE],
    ["cd .. && bash -c 'ls'", NONE],
  ]);
});

// find -exec 本身算不算只读，§7.4（容器）与 §7.7（有 -exec 时 find 不在名单里）两种读法不同；
// 里面的 rm 不是只读，两种读法下都要有 command 为 rm 的 leave，所以只查“包含”
test('FS-48 §7.4 §7.7 the command inside find -exec leaves the working directory', () => {
  const command = 'cd .. && find . -exec rm {} +';
  const leaves = leavesOf(scan('bash', command), command);
  assert.ok(leaves.some((l) => l.form === 'cd' && l.dir === W && l.command === 'rm'), JSON.stringify(leaves));
});

test('FS-48 §7.2 a cd back to the working directory itself is not a leave (samePath)', () => {
  expectAll('bash', [
    ['cd ../proj && npm i', NONE],
    ['cd ../PROJ/ && npm i', NONE],
    ["cd '..\\proj\\.' && npm i", NONE],
    ['cd src && cd .. && npm i', NONE],
    ['git -C .. -C proj commit', NONE],
    ['cd .. && git -C proj commit', NONE],
  ]);
});

test('FS-48 §7.7 names outside the read-only lists leave the working directory', () => {
  const cases = [
    ['npm', 'npm'], ['make', 'make'], ['./x.sh', 'x.sh'], ['git commit', 'git commit'], ['xxd a b', 'xxd'],
    ['find . -delete', 'find'], ['find . -fprint x', 'find'], ['find . -fls x', 'find'],
    ['sort -o x', 'sort'], ['sort --output=x a', 'sort'], ['tree -o x', 'tree'], ['uniq a b', 'uniq'],
    ['git branch new', 'git branch'], ['git config a b', 'git config'], ['git log --output=x', 'git log'],
    ['git stash', 'git stash'], ['git remote add o u', 'git remote'], ['/usr/bin/npm.exe ci', 'npm'],
  ];
  expectAll('bash', cases.map(([command, name]) => [`cd .. && ${command}`, ok([], [lv('cd', '..', W, name)])]));
});

test('FS-48 §7.7 cd skips -L -P -e -@ --; substitutions restore the directory, if does not', () => {
  expectAll('bash', [
    ['cd -P .. && npm i', ok([], [lv('cd', '..', W, 'npm')])],
    ['cd -L -e -@ -- .. && make', ok([], [lv('cd', '..', W, 'make')])],
    ['echo $(cd ..); touch a; cat <(cd ..; ls) > b; echo `cd ..`; touch c', ok([
      wr('touch', 'a', p('a')), wr('>', 'b', p('b')), wr('touch', 'c', p('c')),
    ])],
  ]);
  const branch = scan('bash', 'if true; then cd ..; fi; touch a');
  sameSet(writesOf(branch), [wr('touch', 'a', w('a')), wr('touch', 'a', p('a'))]);
  assert.deepEqual(leavesOf(branch), [lv('cd', '..', W, 'touch')]);
});

test('FS-48 §7.7 pushd, popd and their options', () => {
  expectAll('bash', [
    ['pushd -L ../x && make', ok([], [lv('pushd', '../x', w('x'), 'make')])],
    ['pushd && make', (result) => assert.deepEqual(leavesOf(result).map((l) => [l.form, l.dir, l.command]),
      [['pushd', null, 'make']])],
    ['pushd +1 && make', ok([], [lv('pushd', '+1', null, 'make')])],
    ['popd && make', (result) => assert.deepEqual(leavesOf(result).map((l) => [l.form, l.dir, l.command]),
      [['popd', null, 'make']])],
    ['cd x y && make', (result) => assert.deepEqual(leavesOf(result).map((l) => [l.form, l.dir, l.command]),
      [['cd', null, 'make']])],
  ]);
});

test('FS-48 §17 pushd -n, popd -n, popd +N and dirs -c', () => {
  expectAll('bash', [
    ['pushd -n ../x && make; popd -n && make', NONE],
    ['pushd ../x; popd -n; make', ok([], [lv('pushd', '../x', w('x'), 'make')])],
    ['pushd ../x; pushd ../y; popd +1; make', ok([], [lv('popd', '+1', null, 'make')])],
    ['pushd ../x; popd -1; make', ok([], [lv('popd', '-1', null, 'make')])],
    ['pushd ../x; dirs -c; popd; make', (result) => assert.deepEqual(
      leavesOf(result).map((l) => [l.form, l.dir, l.command]), [['popd', null, 'make']])],
    ['pushd ../x; dirs; popd; make', NONE],
  ]);
});

test('FS-48 §17 mutually exclusive branches: every possible directory is analyzed', () => {
  const both = scan('bash', 'cd sub || cd ..; rm -rf proj');
  sameSet(writesOf(both), [
    wr('rm', 'proj', p('proj'), DEL), wr('rm', 'proj', p('sub', 'proj'), DEL), wr('rm', 'proj', P, DEL),
  ]);
  sameSet(leavesOf(both), [lv('cd', 'sub', p('sub'), 'rm'), lv('cd', '..', W, 'rm')]);
  const branches = scan('bash', 'if true; then cd a; elif x; then cd b; else cd ..; fi; npm i');
  sameSet(leavesOf(branches), [lv('cd', 'a', p('a'), 'npm'), lv('cd', 'b', p('b'), 'npm'), lv('cd', '..', W, 'npm')]);
  const cases = scan('bash', 'case $x in a) cd a;; b) cd ..;; esac; npm i');
  sameSet(leavesOf(cases), [lv('cd', 'a', p('a'), 'npm'), lv('cd', '..', W, 'npm')]);
});

test('FS-48 §17 more than SCAN_MAX_STATES possible directories become one unknown directory', () => {
  assert.equal(scanModule.SCAN_MAX_STATES, 8);
  const caseOf = (n) => {
    const branches = Array.from({ length: n }, (_, k) => `b${k}) cd ../d${k};;`);
    return `case $x in ${branches.join(' ')} esac; npm i`;
  };
  // 7 个分支加上一个都不匹配（还在 P）是 8 种可能：每种都按字面记下
  const eight = leavesOf(scan('bash', caseOf(7)));
  sameSet(eight, Array.from({ length: 7 }, (_, k) => lv('cd', `../d${k}`, w(`d${k}`), 'npm')));
  // 8 个分支是 9 种可能：合成一个看不出来的当前目录
  const nine = leavesOf(scan('bash', caseOf(8)));
  assert.equal(nine.length, 1);
  assert.deepEqual([nine[0].form, nine[0].dir, nine[0].command], ['cd', null, 'npm']);
});

test('FS-48 §17 a loop body that changes directory is analyzed again from an unknown directory', () => {
  expectAll('bash', [
    ['for d in a b; do npm i; cd ..; done', ok([], [lv('cd', '..', null, 'npm')])],
    ['while true; do touch x; cd ..; done', ok([wr('touch', 'x', p('x')), wq('touch', 'x', 'directory')],
      [lv('cd', '..', null, 'touch')])],
    ['until false; do cd sub; done; make', (result) => sameSet(leavesOf(result),
      [lv('cd', 'sub', p('sub'), 'make'), lv('cd', 'sub', null, 'make')])],
    ['for d in a b; do npm i; done', NONE],
  ]);
  const after = leavesOf(scan('bash', 'for d in a b; do cd ..; done; npm i'));
  assert.ok(after.some((l) => l.dir === null && l.command === 'npm'), JSON.stringify(after));
});

test('FS-48 §7.7 git directories: several -C, = and separate forms, export and global options', () => {
  expectAll('bash', [
    ['git -C .. -C x commit', ok([], [lv('git -C', 'x', w('x'), 'git commit')])],
    ['git --git-dir ../o/.git --work-tree ../o add .', ok([], [
      lv('--git-dir', '../o/.git', w('o', '.git'), 'git add'), lv('--work-tree', '../o', w('o'), 'git add'),
    ])],
    ['git -C .. --git-dir=o/.git commit', ok([], [
      lv('git -C', '..', W, 'git commit'), lv('--git-dir', 'o/.git', w('o', '.git'), 'git commit'),
    ])],
    // 前缀的 GIT_DIR=、GIT_WORK_TREE= 也相对 -C 之后的目录解析（同 git：先换 -C）；
    // 同一次 git 调用的几条 leave 谁先谁后规格没定（前缀在文字里在前，-C 在 §7.7 的列表里在前），按集合比较
    ['GIT_DIR=o/.git git -C .. commit', okAnyOrder([], [
      lv('git -C', '..', W, 'git commit'), lv('GIT_DIR', 'o/.git', w('o', '.git'), 'git commit'),
    ])],
    ['GIT_WORK_TREE=../o git -C .. add .', okAnyOrder([], [
      lv('git -C', '..', W, 'git add'), lv('GIT_WORK_TREE', '../o', 'C:\\o', 'git add'),
    ])],
    ['export GIT_DIR=../o/.git; git commit; git log', ok([], [
      lv('GIT_DIR', '../o/.git', w('o', '.git'), 'git commit'),
    ])],
    ['git -p --no-pager --bare --no-replace-objects --literal-pathspecs -c a=b --namespace n --config-env x=y '
      + '-C .. push', ok([], [lv('git -C', '..', W, 'git push')])],
  ]);
});

// ---- FS-49：解析失败、上限、去重、纯函数与时间 ----

test('FS-49 §7.8 every reason that applies to bash has a case', () => {
  expectAll('bash', [
    ["echo 'abc", fail('unclosed quote')],
    ["echo $'abc", fail('unclosed quote')],
    ['echo "a" "b', fail('unclosed quote')],
    ['(echo a; (echo b)', fail('unclosed bracket')],
    ['echo ${HOME', fail('unclosed bracket')],
    ['echo $(ls', fail('unclosed command substitution')],
    ['echo `ls', fail('unclosed command substitution')],
    ['$CC x', fail('the command name comes from a variable or substitution')],
    ['eval $X', fail('the command text comes from a variable or input')],
    ['pwsh -EncodedCommand ZQBj', fail('encoded command')],
    ['env -C .. make', fail('unsupported option -C')],
    ['pwsh -c "Get-Content < in.txt"', fail('PowerShell has no < redirection')],
    ['pwsh -c "npm run build --% > ..\\x"', fail('stop-parsing token')],
    ['pwsh -c "npm run build \'>\' ..\\x"', fail('cmd.exe metacharacter in an argument')],
    [nested(33), fail('nested too deeply')],
    [`echo ${'a'.repeat(scanModule.SCAN_MAX_CHARS)}`, fail('the command is too long')],
  ]);
});

test('FS-49 §7.8 nesting: 32 levels are analyzed, 33 fail; wrappers and functions count as a level', () => {
  assert.equal(scanModule.SCAN_MAX_DEPTH, 32);
  assert.deepEqual(scan('bash', nested(32)), NONE);
  assert.deepEqual(scan('bash', nested(33)), fail('nested too deeply'));
  const bashes = (n) => (n === 0 ? 'touch ../x' : `bash -c ${JSON.stringify(bashes(n - 1))}`);
  assert.deepEqual(scan('bash', bashes(3)), ok([wr('touch', '../x', w('x'))]));
  assert.deepEqual(scan('bash', 'eval '.repeat(40) + 'touch x'), fail('nested too deeply'));
  // §17（2026-10-27）：包装命令、函数体与 coproc 同样算一层
  assert.deepEqual(scan('bash', 'nohup '.repeat(40) + 'touch x'), fail('nested too deeply'));
  assert.deepEqual(scan('bash', `${'f() { '.repeat(33)}touch x${'; }'.repeat(33)}`), fail('nested too deeply'));
  assert.deepEqual(scan('bash', 'coproc '.repeat(40) + 'touch x'), fail('nested too deeply'));
});

test('FS-49 duplicates (B117): same form, text, path and remove keep the first; others stay', () => {
  expectAll('bash', [
    ['touch a; touch a; touch ./a', ok([wr('touch', 'a', p('a')), wr('touch', './a', p('a'))])],
    ['echo > $OUT; echo > $OUT', ok([wq('>', '$OUT', 'variable')])],
    ['rm a; touch a; rm a', ok([wr('rm', 'a', p('a'), DEL), wr('touch', 'a', p('a'))])],
    ['cd .. && npm i; cd proj; cd .. && npm i', ok([], [lv('cd', '..', W, 'npm')])],
  ]);
});

test('FS-49 §17 leaves with the same form, text and command but another dir are both kept', () => {
  expectAll('bash', [
    ['cd .. && npm i; cd .. && npm i', ok([], [lv('cd', '..', W, 'npm'), lv('cd', '..', 'C:\\', 'npm')])],
    ['cd ../a && npm i && cd ../../w/a && npm i', ok([], [
      lv('cd', '../a', w('a'), 'npm'), lv('cd', '../../w/a', w('a'), 'npm'),
    ])],
  ]);
});

test('FS-49 §17 more than SCAN_MAX_RESULTS writes and leaves fail as too long', () => {
  assert.equal(scanModule.SCAN_MAX_RESULTS, 1000);
  const touches = (n) => Array.from({ length: n }, (_, k) => `touch a${k}`).join('; ');
  const most = scan('bash', touches(1000));
  assert.equal(writesOf(most).length, 1000);
  assert.deepEqual(scan('bash', touches(1001)), fail('the command is too long'));
});

test('FS-49 §17 a pushd stack deeper than SCAN_MAX_STACK fails as too long', () => {
  assert.equal(scanModule.SCAN_MAX_STACK, 1000);
  const pushes = (n) => Array.from({ length: n }, () => 'pushd a').join('; ');
  assert.equal(scan('bash', pushes(scanModule.SCAN_MAX_STACK)).ok, true);
  assert.deepEqual(scan('bash', pushes(scanModule.SCAN_MAX_STACK + 1)), fail('the command is too long'));
});

test('FS-49 §17 path work over SCAN_MAX_PATH_WORK characters fails as too long', () => {
  assert.equal(scanModule.SCAN_MAX_PATH_WORK, 64_000_000);
  const dir = 'd'.repeat(32_000);
  const command = (n) => `cd ${dir}; ${Array.from({ length: n }, () => 'echo $PWD').join('; ')}`;
  assert.deepEqual(scan('bash', command(1900)), NONE);
  assert.deepEqual(scan('bash', command(2100)), fail('the command is too long'));
});

/** 纯函数检查用的命令：用到 TEMP、HOME、~、相对路径、以 \ 开头的路径与 $PWD */
const PURE_COMMANDS = [
  'echo > $TEMP/a; echo > $TMPDIR/b; echo > ~/c; echo > $HOME/d; touch e; touch \'\\f\'; touch $PWD/g',
  'cd .. && npm i > log; git -C sub commit; touch //srv/s/x; touch /c/y',
];

test('FS-49 the result is the same after process.env.TEMP, HOME and the current directory change', (context) => {
  const before = PURE_COMMANDS.map((command) => scan('bash', command));
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: process.env.HOME, cwd: process.cwd() };
  const elsewhere = tmpdir();
  context.after(() => {
    for (const name of ['TEMP', 'TMP', 'HOME']) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    process.chdir(saved.cwd);
  });
  process.env.TEMP = 'D:\\elsewhere\\temp';
  process.env.TMP = 'D:\\elsewhere\\tmp';
  process.env.HOME = 'D:\\elsewhere\\home';
  process.chdir(elsewhere);
  assert.notEqual(process.cwd(), saved.cwd);
  const after = PURE_COMMANDS.map((command) => scan('bash', command));
  assert.deepEqual(after, before);
  assert.deepEqual(before[0].writes.map((x) => x.path), [t('a'), t('b'), null, null, p('e'), 'C:\\f', p('g')]);
});

/** FS-49 计时用的 1 MB 命令（几种形状） */
const MEGABYTE_SHAPES = [
  ['short commands', () => megabyte('echo hi; ')],
  ['one long word', () => megabyte('a', 'echo ')],
  ['one long quoted string', () => megabyte('a', "echo '", "'")],
  ['a long pipeline', () => megabyte(' | cat', 'ls')],
  ['if blocks', () => megabyte('if true; then echo a; fi; ')],
  ['cd and a command in && lists', () => megabyte('cd .. && npm i; ')],
  ['substitutions and || lists', () => megabyte('x=$(echo "$y" | grep z) && [ -n "$x" ] || echo "no ${x}"; ')],
  ['a long here-doc', () => megabyte('line of text\n', "cat <<'EOF'\n", 'EOF')],
];

test('FS-49 a 1 MB bash command is analyzed in at most 500 ms', () => {
  timeShapes('bash', MEGABYTE_SHAPES, 'echo warm; cd .. && npm i > x; if a; then b; fi');
});

// ---- FS-50：git 自己的写入不算 ----

test('FS-50 git subcommands never appear in writes', () => {
  const subcommands = [
    'commit -am x', 'add -A', 'checkout main', 'merge b', 'reset --hard', 'stash', 'worktree add ../w', 'clone u x',
    'apply p', 'am m', 'rebase main', 'gc', 'init', 'config a b', 'fetch', 'pull', 'push', 'tag v1', 'branch new',
    'archive -o ../a.zip HEAD', 'switch -c x', 'restore .', 'clean -fd', 'rm x', 'mv a b', 'notes add',
  ];
  const cases = subcommands.map((sub) => [`git ${sub}`, NONE]);
  expectAll('bash', cases);
  expectAll('bash', cases, WORKTREE);
  assert.deepEqual(scan('bash', 'git -C ../../.. merge mori/a; git -C ../../.. commit', WORKTREE), ok([], [
    lv('git -C', '../../..', 'C:\\r', 'git merge'), lv('git -C', '../../..', 'C:\\r', 'git commit'),
  ]));
  assert.deepEqual(scan('bash', 'git log > ../l.txt; rm -rf .git'), ok([
    wr('>', '../l.txt', w('l.txt')), wr('rm', '.git', p('.git'), DEL),
  ]));
});
