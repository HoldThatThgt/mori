// 命令分析：PowerShell（docs/specs/file-system-permissions.md §7.3–§7.9，docs/specs/file-system.md §19.2 的 FS-45…FS-50）。
// 先逐行跑 §7.9 的 PowerShell 表（S1–S60，含 S24a），测试名以所属条目和行号开头，属于两个条目的行各跑一次；再补 §19.2
// 要求的“每种写法至少一行”（§7.5 PowerShell 表的每个 cmdlet、别名、目标参数与位置，§7.6 的 PowerShell 一列，§7.4 里
// PowerShell 的部分，§7.7 的只读名单，§7.8 的原因），以及 §17 里 2026-10-27 登记的实现时补充的做法。
// 命令文字都是手写的（synthetic）；期望照规格的表，表里没写出的 text 按 §7.2 的规则（去掉引号与转义后的原文）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import {
  DEL, GIT_READ_ONLY, INTO, NONE, P, W, expectAll, fail, leavesOf, lv, megabyte, ok, okAnyOrder, p, row, sameSet, scan,
  scanModule, t, tableTests, timeShapes, w, wq, wr, writesOf,
} from './scan-helpers.mjs';

/** worktree 会话的工作路径：主文件夹 C:\r 下的 worktree（同 B114） */
const WORKTREE = 'C:\\r\\.mori\\worktrees\\a';

/** §7.8 的两个常用原因 */
const NAME_FAIL = 'the command name comes from a variable or substitution';
const TEXT_FAIL = 'the command text comes from a variable or input';

/** @brief n 层嵌套的 $( … )：Write-Output $(Write-Output $(… $(Get-Date)))。 */
function nested(levels) {
  return levels === 0 ? 'Get-Date' : `Write-Output $(${nested(levels - 1)})`;
}

// ---- §7.9 PowerShell 表：S1–S30 ----

const ROWS_A = [
  row('S1', 'npm run build', NONE),
  row('S2', 'npm run build > ..\\out.log', ok([wr('>', '..\\out.log', w('out.log'))])),
  row('S3', 'make 2> err.txt; make *> all.log; make 3>> w.log',
    ok([wr('2>', 'err.txt', p('err.txt')), wr('*>', 'all.log', p('all.log')), wr('3>>', 'w.log', p('w.log'))])),
  row('S4', 'make 2>&1; make *>&1 > $null; make > $null', NONE),
  row('S5', 'Set-Content -Path a.txt -Value x; Set-Content b.txt x; sc c.txt x', ok([
    wr('Set-Content', 'a.txt', p('a.txt')), wr('Set-Content', 'b.txt', p('b.txt')),
    wr('Set-Content', 'c.txt', p('c.txt')),
  ])),
  row('S6', "Set-Content -LiteralPath '..\\[x].txt' x; Set-Content -Path '..\\[y].txt' x",
    ok([wr('Set-Content', '..\\[x].txt', w('[x].txt')), wq('Set-Content', '..\\[y].txt', 'glob')])),
  row('S7', "Add-Content notes.md 'line'; ac -Value y -Path ..\\n.md",
    ok([wr('Add-Content', 'notes.md', p('notes.md')), wr('Add-Content', '..\\n.md', w('n.md'))])),
  row('S8', "'x' | Out-File ..\\o.txt -Encoding utf8; Out-File -FilePath:a.txt; Out-File -Path b.txt; "
    + 'Out-File -LP c.txt -Append', ok([
    wr('Out-File', '..\\o.txt', w('o.txt')), wr('Out-File', 'a.txt', p('a.txt')), wr('Out-File', 'b.txt', p('b.txt')),
    wr('Out-File', 'c.txt', p('c.txt')),
  ])),
  row('S9', 'Get-Process | Tee-Object -FilePath p.txt; ls | tee q.txt; ls | Tee-Object -Variable v',
    ok([wr('Tee-Object', 'p.txt', p('p.txt')), wr('Tee-Object', 'q.txt', p('q.txt'))])),
  row('S10', 'New-Item -ItemType Directory -Path build; ni x.txt; mkdir a\\b; md ..\\c', ok([
    wr('New-Item', 'build', p('build')), wr('New-Item', 'x.txt', p('x.txt')), wr('New-Item', 'a\\b', p('a', 'b')),
    wr('New-Item', '..\\c', w('c')),
  ])),
  row('S11', 'New-Item -Path src -Name a.ts; New-Item -Name b.ts -ItemType File',
    ok([wr('New-Item', 'src\\a.ts', p('src', 'a.ts')), wr('New-Item', 'b.ts', p('b.ts'))])),
  row('S12', 'New-Item -ItemType SymbolicLink -Path link -Target ..\\x', ok([wr('New-Item', 'link', p('link'))])),
  row('S13', 'Copy-Item a.txt ..\\b.txt; cp a b; copy a c; cpi -Path a -Destination dist; Copy-Item a; '
    + 'Copy-Item a ..\\bk\\', ok([
    wr('Copy-Item', '..\\b.txt', w('b.txt')), wr('Copy-Item', 'b', p('b')), wr('Copy-Item', 'c', p('c')),
    wr('Copy-Item', 'dist', p('dist')), wr('Copy-Item', '.', P, INTO), wr('Copy-Item', '..\\bk\\', w('bk'), INTO),
  ])),
  row('S14', 'Move-Item a ..\\b; mv x y; mi z', ok([
    wr('Move-Item', 'a', p('a'), DEL), wr('Move-Item', '..\\b', w('b')), wr('Move-Item', 'x', p('x'), DEL),
    wr('Move-Item', 'y', p('y')), wr('Move-Item', 'z', p('z'), DEL), wr('Move-Item', '.', P, INTO),
  ])),
  row('S15', 'Remove-Item -Recurse -Force dist; rm a; del b; erase c; rd d; ri e; rmdir f',
    ok(['dist', 'a', 'b', 'c', 'd', 'e', 'f'].map((name) => wr('Remove-Item', name, p(name), DEL)))),
  row('S16', 'Remove-Item a, b,..\\c', ok([
    wr('Remove-Item', 'a', p('a'), DEL), wr('Remove-Item', 'b', p('b'), DEL), wr('Remove-Item', '..\\c', w('c'), DEL),
  ])),
  row('S17', 'Rename-Item a.txt b.txt; ren src\\x.ts y.ts', ok([
    wr('Rename-Item', 'a.txt', p('a.txt'), DEL), wr('Rename-Item', 'b.txt', p('b.txt')),
    wr('Rename-Item', 'src\\x.ts', p('src', 'x.ts'), DEL), wr('Rename-Item', 'y.ts', p('src', 'y.ts')),
  ])),
  row('S18', 'Copy-Item a -Dest ..\\b; Remove-Item -Rec -Fo x',
    ok([wr('Copy-Item', '..\\b', w('b')), wr('Remove-Item', 'x', p('x'), DEL)])),
  row('S19', 'Set-Content -P a x', ok([wq('Set-Content', '(unrecognized parameters of Set-Content)', 'parameter')])),
  row('S20', 'rm -rf build; Copy-Item a -Frobnicate x -Destination b; Remove-Item a b; Copy-Item @p', ok([
    wq('Remove-Item', '(unrecognized parameters of Remove-Item)', 'parameter', DEL),
    wq('Copy-Item', '(unrecognized parameters of Copy-Item)', 'parameter'),
    wq('Remove-Item', '(unrecognized parameters of Remove-Item)', 'parameter', DEL),
    wq('Copy-Item', '(unrecognized parameters of Copy-Item)', 'parameter'),
  ])),
  row('S21', 'Get-ChildItem *.tmp | Remove-Item; ls *.log | % { Remove-Item $_ }; dir | Copy-Item -Destination ..\\bk',
    ok([
      wq('Remove-Item', '(paths from input)', 'input', DEL), wq('Remove-Item', '$_', 'variable', DEL),
      wr('Copy-Item', '..\\bk', w('bk')),
    ])),
  row('S22', 'Out-File $out; Out-File "$env:TEMP\\x.txt"; Out-File $env:tmp\\y; Out-File "${env:TMPDIR}\\z"', ok([
    wq('Out-File', '$out', 'variable'), wr('Out-File', '$env:TEMP\\x.txt', t('x.txt')),
    wr('Out-File', '$env:tmp\\y', t('y')), wr('Out-File', '${env:TMPDIR}\\z', t('z')),
  ])),
  row('S23', 'Out-File "$HOME\\x"; Out-File ~\\x; Out-File "$PWD\\x"; Out-File $pwd\\y', ok([
    wq('Out-File', '$HOME\\x', 'variable'), wq('Out-File', '~\\x', 'home'), wr('Out-File', '$PWD\\x', p('x')),
    wr('Out-File', '$pwd\\y', p('y')),
  ])),
  row('S24', "$env:TEMP = 'D:\\t'; Out-File $env:TEMP\\x", ok([wq('Out-File', '$env:TEMP\\x', 'variable')])),
  row('S24a', "$env:TEMP = 'D:\\t'; pwsh -c 'Out-File $env:TEMP\\x'", ok([wq('Out-File', '$env:TEMP\\x', 'variable')])),
  row('S25', 'Out-File "$(Get-Date -f yyyy).log"; Out-File (Join-Path $PWD x)', ok([
    wq('Out-File', '$(Get-Date -f yyyy).log', 'substitution'), wq('Out-File', '(Join-Path $PWD x)', 'substitution'),
  ])),
  row('S26', 'Remove-Item Env:\\FOO; New-Item HKCU:\\Software\\X; Set-Content Temp:\\x y; '
    + 'Remove-Item FileSystem::C:\\w\\x', ok([
    wq('Remove-Item', 'Env:\\FOO', 'provider', DEL), wq('New-Item', 'HKCU:\\Software\\X', 'provider'),
    wq('Set-Content', 'Temp:\\x', 'provider'), wr('Remove-Item', 'FileSystem::C:\\w\\x', w('x'), DEL),
  ])),
  row('S27', 'Out-File C:x.txt; Out-File \\x.txt; Out-File /y.txt; Out-File \\\\srv\\s\\z', ok([
    wq('Out-File', 'C:x.txt', 'drive-relative'), wr('Out-File', '\\x.txt', 'C:\\x.txt'),
    wr('Out-File', '/y.txt', 'C:\\y.txt'), wr('Out-File', '\\\\srv\\s\\z', '\\\\srv\\s\\z'),
  ])),
  row('S28', 'Set-Location ..; npm i', ok([], [lv('Set-Location', '..', W, 'npm')])),
  row('S29', 'cd ..; Get-ChildItem; git status; Select-String x *.ts', NONE),
  row('S30', 'sl src; Out-File a; cd ..\\..; Out-File b', ok(
    [wr('Out-File', 'a', p('src', 'a')), wr('Out-File', 'b', w('b'))],
    [lv('Set-Location', 'src', p('src'), 'Out-File'), lv('Set-Location', '..\\..', W, 'Out-File')],
  )),
];

// ---- §7.9 PowerShell 表：S31–S60 ----

const ROWS_B = [
  row('S31', 'Push-Location ..\\x; make; Pop-Location; make; pushd ..; popd; make',
    ok([], [lv('Push-Location', '..\\x', w('x'), 'make')])),
  row('S32', 'cd -; npm i', ok([], [lv('Set-Location', '-', null, 'npm')])),
  row('S33', 'Set-Location; npm i', ok([], [lv('Set-Location', '~', null, 'npm')])),
  row('S34', '( cd .. ); npm i; & { cd .\\proj }; npm i', ok([], [lv('Set-Location', '..', W, 'npm')])),
  row('S35', 'git -C .. merge mori/x; git -C .. log', ok([], [lv('git -C', '..', W, 'git merge')])),
  row('S36', "$env:GIT_DIR = '..\\o\\.git'; git commit -m x",
    ok([], [lv('GIT_DIR', '..\\o\\.git', w('o', '.git'), 'git commit')])),
  row('S37', 'if (Test-Path a) { Remove-Item a } elseif ($b) { ni c } else { rm d }', ok([
    wr('Remove-Item', 'a', p('a'), DEL), wr('New-Item', 'c', p('c')), wr('Remove-Item', 'd', p('d'), DEL),
  ])),
  row('S38', 'foreach ($f in $files) { Copy-Item $f ..\\bk }; $r = Copy-Item a b -PassThru; '
    + 'try { Remove-Item x } catch { } finally { ni y }', ok([
    wr('Copy-Item', '..\\bk', w('bk')), wr('Copy-Item', 'b', p('b')), wr('Remove-Item', 'x', p('x'), DEL),
    wr('New-Item', 'y', p('y')),
  ])),
  row('S39', '& { Remove-Item ..\\x }; Invoke-Command -ScriptBlock { ni y }; $h = @{ a = (ni z) }', ok([
    wr('Remove-Item', '..\\x', w('x'), DEL), wr('New-Item', 'y', p('y')), wr('New-Item', 'z', p('z')),
  ])),
  row('S40', 'if ($a > 5) { }; if ($a -gt 5) { }', ok([wr('>', '5', p('5'))])),
  row('S41', "switch ($x) { 'a' { ni a } default { rm b } }",
    ok([wr('New-Item', 'a', p('a')), wr('Remove-Item', 'b', p('b'), DEL)])),
  row('S42', "@'\nRemove-Item ..\\x\n'@ | Set-Content s.txt", ok([wr('Set-Content', 's.txt', p('s.txt'))])),
  row('S43', '@"\n$(Remove-Item ..\\x)\n"@ | Out-File f',
    ok([wr('Remove-Item', '..\\x', w('x'), DEL), wr('Out-File', 'f', p('f'))])),
  row('S44', '# Remove-Item ..\\x\n<# rm ..\\y #> Get-ChildItem', NONE),
  row('S45', 'Copy-Item a `\n -Destination ..\\b; Out-File a` b.txt',
    ok([wr('Copy-Item', '..\\b', w('b')), wr('Out-File', 'a b.txt', p('a b.txt'))])),
  row('S46', "Out-File 'it''s.txt'; Out-File \"a b.txt\"; Out-File ‘c.txt’", ok([
    wr('Out-File', "it's.txt", p("it's.txt")), wr('Out-File', 'a b.txt', p('a b.txt')),
    wr('Out-File', 'c.txt', p('c.txt')),
  ])),
  row('S47', '& $exe build', fail(NAME_FAIL)),
  row('S48', "& 'C:\\tools\\x.exe' build; & git -C .. merge b; .\\build.ps1; . .\\env.ps1",
    ok([], [lv('git -C', '..', W, 'git merge')])),
  row('S49', 'iex \'Remove-Item ..\\x\'; Invoke-Expression -Command "ni y"',
    ok([wr('Remove-Item', '..\\x', w('x'), DEL), wr('New-Item', 'y', p('y'))])),
  row('S50', 'Invoke-Expression $s', fail(TEXT_FAIL)),
  row('S51', 'bash -c \'rm -rf ../x\'; pwsh -c "Out-File ..\\y"',
    ok([wr('rm', '../x', w('x'), DEL), wr('Out-File', '..\\y', w('y'))])),
  row('S52', 'Out-File "abc', fail('unclosed quote')),
  row('S53', 'Get-Content < in.txt', fail('PowerShell has no < redirection')),
  row('S54', 'ls | % { ni a', fail('unclosed bracket')),
  row('S55', "Out-File .work\\notes.md; New-TemporaryFile; [IO.File]::WriteAllText('..\\x', 'y'); "
    + 'Invoke-WebRequest u -OutFile ..\\z', ok([wr('Out-File', '.work\\notes.md', p('.work', 'notes.md'))])),
  row('S56', 'Microsoft.PowerShell.Management\\Remove-Item ..\\x; Remove-Item a -WhatIf',
    ok([wr('Remove-Item', '..\\x', w('x'), DEL), wr('Remove-Item', 'a', p('a'), DEL)])),
  row('S57', "cmd /c \"del ..\\x\"; sed -i 's/a/b/' f; touch g", NONE),
  row('S58', 'npm run build --% > ..\\x', fail('stop-parsing token')),
  row('S59', "npm run build '>' ..\\x; npm run build '2>..\\e'; .\\t.cmd 'a|b'",
    fail('cmd.exe metacharacter in an argument')),
  row('S60', "git log --format='%h|%s'", fail('cmd.exe metacharacter in an argument')),
];

tableTests('powershell', [...ROWS_A, ...ROWS_B]);

// ---- FS-45：§7.5 PowerShell 表的每个 cmdlet、别名、目标参数与位置 ----

test('FS-45 §7.5 Set-Content and Add-Content: Path at 0, LiteralPath, PSPath, LP; aliases sc and ac', () => {
  expectAll('powershell', [
    ['Set-Content -LiteralPath a x; Set-Content -PSPath b x; Set-Content -LP c x; sc d x', ok([
      wr('Set-Content', 'a', p('a')), wr('Set-Content', 'b', p('b')), wr('Set-Content', 'c', p('c')),
      wr('Set-Content', 'd', p('d')),
    ])],
    ['Add-Content x y; Add-Content -LiteralPath a y; Add-Content -PSPath b y; ac -LP c y; ac -Path e y', ok([
      wr('Add-Content', 'x', p('x')), wr('Add-Content', 'a', p('a')), wr('Add-Content', 'b', p('b')),
      wr('Add-Content', 'c', p('c')), wr('Add-Content', 'e', p('e')),
    ])],
    ['Set-Content -Path a -Value x -NoNewline -Force -Encoding utf8 -Stream s -Filter f -Include i -Exclude e '
      + '-Credential c', ok([wr('Set-Content', 'a', p('a'))])],
    ['Set-Content -Value x -Path:b; Add-Content -Value:y c', ok([
      wr('Set-Content', 'b', p('b')), wr('Add-Content', 'c', p('c')),
    ])],
  ]);
});

test('FS-45 §7.5 Out-File and Tee-Object: FilePath at 0, Path, LiteralPath, PSPath, LP; alias tee', () => {
  expectAll('powershell', [
    ['Out-File -LiteralPath a; Out-File -PSPath b; Out-File c utf8', ok([
      wr('Out-File', 'a', p('a')), wr('Out-File', 'b', p('b')), wr('Out-File', 'c', p('c')),
    ])],
    ['Out-File a -Append -NoClobber -Width 80 -InputObject x; Out-File b -NoOverwrite -AsByteStream', ok([
      wr('Out-File', 'a', p('a')), wr('Out-File', 'b', p('b')),
    ])],
    ['ls | Tee-Object q; ls | Tee-Object -Path r; ls | Tee-Object -LiteralPath s; ls | tee -PSPath t; ls | tee -LP u',
      ok(['q', 'r', 's', 't', 'u'].map((name) => wr('Tee-Object', name, p(name))))],
    ['Tee-Object -InputObject x -Variable v; Tee-Object -FilePath z -Encoding utf8', ok([
      wr('Tee-Object', 'z', p('z')),
    ])],
  ]);
});

test('FS-45 §7.5 New-Item: Path at 0 (arrays), Name, ItemType, Value, Target; aliases ni, mkdir, md', () => {
  expectAll('powershell', [
    ['New-Item -Path a, b; md x; mkdir y; ni z', ok(['a', 'b', 'x', 'y', 'z'].map((n) => wr('New-Item', n, p(n))))],
    ['New-Item -ItemType Directory -Name x -Value v -Path p; New-Item -Type File -Target t q', ok([
      wr('New-Item', 'p\\x', p('p', 'x')), wr('New-Item', 'q', p('q')),
    ])],
    ['ls | New-Item -Name z', ok([wr('New-Item', 'z', p('z'))])],
    ['New-Item b -ItemType Directory -Container -Force', ok([wr('New-Item', 'b', p('b'))])],
  ]);
});

test('FS-45 §7.5 Copy-Item: Destination at 1, Path and LiteralPath are sources; aliases cp, copy, cpi', () => {
  expectAll('powershell', [
    ['Copy-Item -Path a -Destination b; Copy-Item -LiteralPath a c; copy -Destination d a', ok([
      wr('Copy-Item', 'b', p('b')), wr('Copy-Item', 'c', p('c')), wr('Copy-Item', 'd', p('d')),
    ])],
    ['Copy-Item a -Destination ..\\x -FromSession s -ToSession t -Filter f -Include i -Exclude e -Credential c '
      + '-Recurse -Container -PassThru', ok([wr('Copy-Item', '..\\x', w('x'))])],
    ['Copy-Item a -Destination ..\\x\\.; Copy-Item c -Destination ..; cpi d ..\\y/', ok([
      wr('Copy-Item', '..\\x\\.', w('x'), INTO), wr('Copy-Item', '..', W, INTO),
      wr('Copy-Item', '..\\y/', w('y'), INTO),
    ])],
    ['Copy-Item a b c', ok([wq('Copy-Item', '(unrecognized parameters of Copy-Item)', 'parameter')])],
  ]);
});

test('FS-45 §7.5 Move-Item: Path at 0, LiteralPath, Destination at 1; aliases mv, move, mi', () => {
  expectAll('powershell', [
    ['Move-Item -Path a -Destination b; move c d; Move-Item -LiteralPath e f', ok([
      wr('Move-Item', 'a', p('a'), DEL), wr('Move-Item', 'b', p('b')), wr('Move-Item', 'c', p('c'), DEL),
      wr('Move-Item', 'd', p('d')), wr('Move-Item', 'e', p('e'), DEL), wr('Move-Item', 'f', p('f')),
    ])],
    ['Move-Item b ..\\y/', ok([wr('Move-Item', 'b', p('b'), DEL), wr('Move-Item', '..\\y/', w('y'), INTO)])],
    ['Get-Item a | Move-Item -Destination ..\\b', ok([
      wq('Move-Item', '(paths from input)', 'input', DEL), wr('Move-Item', '..\\b', w('b')),
    ])],
  ]);
});

test('FS-45 §7.5 Remove-Item and Rename-Item: Path at 0, LiteralPath, NewName at 1; aliases', () => {
  expectAll('powershell', [
    ['Remove-Item -Path a; Remove-Item -LiteralPath b; Remove-Item c -Stream s -Filter f -Include i -Exclude e', ok([
      wr('Remove-Item', 'a', p('a'), DEL), wr('Remove-Item', 'b', p('b'), DEL), wr('Remove-Item', 'c', p('c'), DEL),
    ])],
    ['Rename-Item -Path a -NewName b; rni c d; Rename-Item -LiteralPath e -NewName f; Rename-Item src\\g -NewName h',
      ok([
        wr('Rename-Item', 'a', p('a'), DEL), wr('Rename-Item', 'b', p('b')), wr('Rename-Item', 'c', p('c'), DEL),
        wr('Rename-Item', 'd', p('d')), wr('Rename-Item', 'e', p('e'), DEL), wr('Rename-Item', 'f', p('f')),
        wr('Rename-Item', 'src\\g', p('src', 'g'), DEL), wr('Rename-Item', 'h', p('src', 'h')),
      ])],
    ['Get-Item a | Rename-Item -NewName b', ok([
      wq('Rename-Item', '(paths from input)', 'input', DEL), wq('Rename-Item', 'b', 'input'),
    ])],
  ]);
});

// §7.2：remove 为真时 into 为假；§7.5：只有 Copy-Item、Move-Item 的 Destination 会落进目录
test('FS-45 §7.2 §7.5 into stays false for removals, New-Item, Rename-Item and the content cmdlets', () => {
  expectAll('powershell', [
    [String.raw`Remove-Item ..\x\; Move-Item ..\s\ d; New-Item ..\n\; Rename-Item ..\r\ q`, ok([
      wr('Remove-Item', '..\\x\\', w('x'), DEL), wr('Move-Item', '..\\s\\', w('s'), DEL),
      wr('Move-Item', 'd', p('d')), wr('New-Item', '..\\n\\', w('n')), wr('Rename-Item', '..\\r\\', w('r'), DEL),
      wr('Rename-Item', 'q', w('q')),
    ])],
    [String.raw`Remove-Item ..\a\.; New-Item ..\m\..`, ok([
      wr('Remove-Item', '..\\a\\.', w('a'), DEL), wr('New-Item', '..\\m\\..', W),
    ])],
    [String.raw`'x' | Out-File ..\o\; Set-Content ..\c\ v; Add-Content ..\a\. v`, ok([
      wr('Out-File', '..\\o\\', w('o')), wr('Set-Content', '..\\c\\', w('c')), wr('Add-Content', '..\\a\\.', w('a')),
    ])],
  ]);
});

test('FS-45 §7.5 parameter rules: switches, common parameters, prefixes, :value, arrays and bad parameters', () => {
  expectAll('powershell', [
    ['Remove-Item a -Recurse -Force:$false -Verbose -Debug -WhatIf -Confirm:$false -UseTransaction', ok([
      wr('Remove-Item', 'a', p('a'), DEL),
    ])],
    ['Remove-Item a -ErrorAction Stop -WarningAction x -InformationAction x -ProgressAction x -ErrorVariable e '
      + '-WarningVariable w -InformationVariable i -OutVariable o -OutBuffer 1 -PipelineVariable v', ok([
      wr('Remove-Item', 'a', p('a'), DEL),
    ])],
    ['Remove-Item b -ea 0 -wa 0', ok([wr('Remove-Item', 'b', p('b'), DEL)])],
    ['Copy-Item a -Dest ..\\b; Remove-Item -Rec -Fo x; Set-Content -Pat c x', ok([
      wr('Copy-Item', '..\\b', w('b')), wr('Remove-Item', 'x', p('x'), DEL), wr('Set-Content', 'c', p('c')),
    ])],
    ['Remove-Item a , b ,c', ok(['a', 'b', 'c'].map((n) => wr('Remove-Item', n, p(n), DEL)))],
    ['Set-Content -Pa a x; Remove-Item -Frob a; Remove-Item @args', ok([
      wq('Set-Content', '(unrecognized parameters of Set-Content)', 'parameter'),
      wq('Remove-Item', '(unrecognized parameters of Remove-Item)', 'parameter', DEL),
      wq('Remove-Item', '(unrecognized parameters of Remove-Item)', 'parameter', DEL),
    ])],
    ['Get-Item a | Set-Content -Value x; Get-Item b | Out-File', ok([
      wq('Set-Content', '(paths from input)', 'input'), wq('Out-File', '(paths from input)', 'input'),
    ])],
  ]);
});

test('FS-45 §7.4 PowerShell command names: case, module qualifier, aliases', () => {
  expectAll('powershell', [
    ['REMOVE-ITEM a; RM b; Microsoft.PowerShell.Management\\New-Item c', ok([
      wr('Remove-Item', 'a', p('a'), DEL), wr('Remove-Item', 'b', p('b'), DEL), wr('New-Item', 'c', p('c')),
    ])],
    ['sed -i s/a/b/ f; touch g; ln -s a b', NONE],
  ]);
});

test('FS-45 §7.4 arguments of external programs: cmd.exe metacharacters without whitespace fail', () => {
  const meta = fail('cmd.exe metacharacter in an argument');
  expectAll('powershell', [
    ["npm run build 'a > b'", NONE],
    ["Write-Output '>'; echo 'a|b'; Get-Foo 'a&b'", NONE],
    ["function f { }; f 'a|b'", NONE],
    [".\\x.ps1 'a&b'", NONE],
    ["& npm.cmd 'a<b'", meta],
    ["where.exe cmd '>' x", meta],
    ['x "a&b"', meta],
  ]);
});

// ---- FS-46：§7.6 表里 PowerShell 一列的每种写法 ----

test('FS-46 §7.6 PowerShell: relative, drive, rooted and UNC paths', () => {
  expectAll('powershell', [
    ["Out-File .\\a; Out-File ..\\b; Out-File c/d; Out-File C:\\x; Out-File 'C:/y'; Out-File //srv/s/z", ok([
      wr('Out-File', '.\\a', p('a')), wr('Out-File', '..\\b', w('b')), wr('Out-File', 'c/d', p('c', 'd')),
      wr('Out-File', 'C:\\x', 'C:\\x'), wr('Out-File', 'C:/y', 'C:\\y'), wr('Out-File', '//srv/s/z', '\\\\srv\\s\\z'),
    ])],
    ['Out-File C:y.txt', ok([wq('Out-File', 'C:y.txt', 'drive-relative')])],
  ]);
  expectAll('powershell', [['Out-File \\x; Out-File /y', ok([
    wr('Out-File', '\\x', 'D:\\x'), wr('Out-File', '/y', 'D:\\y'),
  ])]], 'D:\\w\\proj');
});

test('FS-46 §7.6 PowerShell: ~ (quotes too) and variables', () => {
  expectAll('powershell', [
    ["Out-File ~; Out-File ~/a; Out-File '~\\b'; Out-File \"~/c\"; Out-File a~b", ok([
      wq('Out-File', '~', 'home'), wq('Out-File', '~/a', 'home'), wq('Out-File', '~\\b', 'home'),
      wq('Out-File', '~/c', 'home'), wr('Out-File', 'a~b', p('a~b')),
    ])],
    ['Out-File $ENV:Temp\\a; Out-File ${env:tmp}\\b; Out-File $Env:TMPDIR', ok([
      wr('Out-File', '$ENV:Temp\\a', t('a')), wr('Out-File', '${env:tmp}\\b', t('b')),
      wr('Out-File', '$Env:TMPDIR', t()),
    ])],
    ['Out-File $PWD; Out-File $env:USERPROFILE\\a; Out-File $x.y; Out-File $x[0]; Out-File $HOME', ok([
      wr('Out-File', '$PWD', P), wq('Out-File', '$env:USERPROFILE\\a', 'variable'), wq('Out-File', '$x.y', 'variable'),
      wq('Out-File', '$x[0]', 'variable'), wq('Out-File', '$HOME', 'variable'),
    ])],
    ['cd src; Out-File $PWD\\a', ok([wr('Out-File', '$PWD\\a', p('src', 'a'))],
      [lv('Set-Location', 'src', p('src'), 'Out-File')])],
    ["$env:tmp = 'x'; Out-File $env:TMP\\a", ok([wq('Out-File', '$env:TMP\\a', 'variable')])],
  ]);
});

test('FS-46 §7.6 PowerShell: substitution, glob, LiteralPath, providers, input and parameters', () => {
  expectAll('powershell', [
    ["Out-File $(Get-Location)\\a; Out-File @('x'); Out-File ('y')", ok([
      wq('Out-File', '$(Get-Location)\\a', 'substitution'), wq('Out-File', "@('x')", 'substitution'),
      wq('Out-File', "('y')", 'substitution'),
    ])],
    ["Out-File a*b; Out-File 'c?d'; Out-File \"[e]\"; Out-File -LiteralPath 'f*g'; Out-File -LiteralPath h?i", ok([
      wq('Out-File', 'a*b', 'glob'), wq('Out-File', 'c?d', 'glob'), wq('Out-File', '[e]', 'glob'),
      wr('Out-File', 'f*g', p('f*g')), wr('Out-File', 'h?i', p('h?i')),
    ])],
    ['Remove-Item HKLM:\\x; Remove-Item Function:\\f; Remove-Item Variable:\\v; Remove-Item Alias:\\a; '
      + 'Remove-Item Cert:\\c; Remove-Item WSMan:\\w; Remove-Item Registry::HKEY_CURRENT_USER\\x', ok([
      'HKLM:\\x', 'Function:\\f', 'Variable:\\v', 'Alias:\\a', 'Cert:\\c', 'WSMan:\\w',
      'Registry::HKEY_CURRENT_USER\\x',
    ].map((text) => wq('Remove-Item', text, 'provider', DEL)))],
    ['Remove-Item Microsoft.PowerShell.Core\\FileSystem::C:\\w\\x; Remove-Item FileSystem::..\\y', ok([
      wr('Remove-Item', 'Microsoft.PowerShell.Core\\FileSystem::C:\\w\\x', w('x'), DEL),
      wr('Remove-Item', 'FileSystem::..\\y', w('y'), DEL),
    ])],
    ['ls | Remove-Item', ok([wq('Remove-Item', '(paths from input)', 'input', DEL)])],
    ['Remove-Item a b', ok([wq('Remove-Item', '(unrecognized parameters of Remove-Item)', 'parameter', DEL)])],
    ['Set-Location $d; Out-File a', ok([wq('Out-File', 'a', 'directory')],
      [lv('Set-Location', '$d', null, 'Out-File')])],
  ]);
});

// ---- FS-47：§7.4 里 PowerShell 的部分 ----

test('FS-47 §7.4 Invoke-Expression, & and scripts', () => {
  expectAll('powershell', [
    ["iex 'ni ../a'; Invoke-Expression -Command 'ni b'", ok([
      wr('New-Item', '../a', w('a')), wr('New-Item', 'b', p('b')),
    ])],
    ['iex (Get-Content s.ps1 -Raw)', fail(TEXT_FAIL)],
    ['iex "ni $x"', fail(TEXT_FAIL)],
    ["& 'C:\\tools\\x.exe' build; & { ni c }", ok([wr('New-Item', 'c', p('c'))])],
    ['& "git" -C .. merge x', ok([], [lv('git -C', '..', W, 'git merge')])],
    ['& (Get-Command x) y', fail(NAME_FAIL)],
    ['& $(x) y', fail(NAME_FAIL)],
    ['.\\x.ps1; . .\\x.ps1; & .\\x.ps1; . ./y.ps1', NONE],
    ["cmd /c \"del ..\\x\"; python -c \"open('../x','w')\"; node -e x; wsl rm ../x; ssh h rm x; docker run x", NONE],
  ]);
});

test('FS-47 §7.4 nested shells from PowerShell and inherited unknown variables', () => {
  expectAll('powershell', [
    ["bash -c 'touch ../a'; sh -c 'mkdir b'", ok([wr('touch', '../a', w('a')), wr('mkdir', 'b', p('b'))])],
    ["pwsh -NoProfile -Command 'ni ../c'; powershell 'ni d'", ok([
      wr('New-Item', '../c', w('c')), wr('New-Item', 'd', p('d')),
    ])],
    ["$env:TEMP = '..'; bash -c 'echo > $TEMP/x'", ok([wq('>', '$TEMP/x', 'variable')])],
    ["$env:CDPATH = '..'; bash -c 'cd src && touch x'", ok([wq('touch', 'x', 'directory')],
      [lv('cd', 'src', null, 'touch')])],
    ['pwsh -EncodedCommand ZQBj', fail('encoded command')],
    ['pwsh -wd .. -c "ni a"', fail('unsupported option -wd')],
    ["'ni a' | pwsh -Command -", fail(TEXT_FAIL)],
    ['pwsh -File x.ps1; pwsh y.ps1', NONE],
  ]);
});

// §7.4：脚本不分析。脚本名与参数故意写成写入命令的样子：错把它们当命令文字分析的实现会报出写入；
// 对照行 powershell（5.1）的位置参数照 -Command 分析，同样的文字就是写入
test('FS-47 §7.4 pwsh -File / first positional and bash / sh scripts: write-like names stay NONE', () => {
  expectAll('powershell', [
    [String.raw`pwsh ni ..\a`, NONE],
    [String.raw`pwsh -File ni ..\a`, NONE],
    [String.raw`pwsh -f Remove-Item ..\a`, NONE],
    [String.raw`pwsh -NoProfile ni ..\a`, NONE],
    ['bash touch ../x; sh rm ../x; bash -e mkdir ../y', NONE],
    [String.raw`powershell ni ..\a`, ok([wr('New-Item', '..\\a', w('a'))])],
    [String.raw`powershell.exe -NoProfile Remove-Item ..\b`, ok([wr('Remove-Item', '..\\b', w('b'), DEL)])],
  ]);
});

test('FS-47 §17 Invoke-Expression keeps a Set-Location for the commands after it, pwsh -c does not', () => {
  expectAll('powershell', [
    ["iex 'cd ..'; npm i", ok([], [lv('Set-Location', '..', W, 'npm')])],
    ["Invoke-Expression -Command 'Set-Location ..'; Out-File a", ok([wr('Out-File', 'a', w('a'))],
      [lv('Set-Location', '..', W, 'Out-File')])],
    ["pwsh -c 'cd ..'; npm i", NONE],
    ["powershell -Command 'cd ..; npm i'; npm i", ok([], [lv('Set-Location', '..', W, 'npm')])],
    ["bash -c 'cd ..'; npm i", NONE],
  ]);
});

// ---- FS-48：换目录、只读名单与 §17 的位置函数、位置栈、几种可能 ----

/** §7.7 PowerShell 的只读名单：cmdlet 全名与外部程序（照抄规格的顺序） */
const PS_READ_ONLY = [
  'Get-ChildItem', 'Get-Content', 'Get-Item', 'Get-ItemProperty', 'Get-Location', 'Test-Path', 'Resolve-Path',
  'Split-Path', 'Join-Path', 'Select-String', 'Measure-Object', 'Get-FileHash', 'Compare-Object', 'Select-Object',
  'Where-Object', 'ForEach-Object', 'Sort-Object', 'Group-Object', 'Format-Table', 'Format-List', 'Format-Wide',
  'Out-String', 'Out-Host', 'Out-Null', 'Write-Output', 'Write-Host', 'Write-Error', 'Write-Warning', 'Write-Verbose',
  'Get-Command', 'Get-Help', 'Get-Date', 'Get-Process', 'Get-Service', 'Get-Variable', 'Get-Alias', 'ConvertFrom-Json',
  'ConvertTo-Json', 'Start-Sleep', 'where', 'findstr', 'rg', 'whoami', 'hostname',
];

/** §7.7 PowerShell 名单里的别名 */
const PS_READ_ONLY_ALIASES = [
  'ls', 'dir', 'gci', 'cat', 'gc', 'type', 'gi', 'gp', 'pwd', 'gl', 'rvpa', 'sls', 'measure', 'compare', 'diff',
  'select', '?', 'foreach', '%', 'sort', 'group', 'ft', 'fl', 'fw', 'echo', 'write', 'gcm', 'help', 'man', 'gps', 'ps',
  'gsv', 'gv', 'gal', 'sleep',
];

// 规格只定名单的内容，不定顺序：按集合比较
test('FS-48 §7.7 every PowerShell read-only name: cd ..; <name> has no leave', () => {
  sameSet(scanModule.READ_ONLY_COMMANDS.powershell, PS_READ_ONLY, 'READ_ONLY_COMMANDS.powershell');
  expectAll('powershell', [...PS_READ_ONLY, ...PS_READ_ONLY_ALIASES, ...GIT_READ_ONLY].map((name) => [
    `cd ..; ${name}`, NONE,
  ]));
});

test('FS-48 §7.7 PowerShell names outside the read-only lists leave the working directory', () => {
  const cases = [
    ['npm i', 'npm'], ['make', 'make'], ['.\\x.ps1', 'x.ps1'], ['git commit', 'git commit'],
    ['git branch new', 'git branch'], ['git config a b', 'git config'], ['git log --output=x', 'git log'],
    ['Start-Process x', 'Start-Process'], ['Clear-Content a', 'Clear-Content'], ['xxd a b', 'xxd'],
  ];
  expectAll('powershell', cases.map(([command, name]) => [
    `cd ..; ${command}`, ok([], [lv('Set-Location', '..', W, name)]),
  ]));
  assert.deepEqual(scan('powershell', 'cd ..; Remove-Item x'),
    ok([wr('Remove-Item', 'x', w('x'), DEL)], [lv('Set-Location', '..', W, 'Remove-Item')]));
});

// §7.7：& { }、Invoke-Expression 这类容器不算命令，里面的命令各自算；ForEach-Object 只读，它的脚本块另算
test('FS-48 §7.7 PowerShell containers and script blocks: each command inside is counted on its own', () => {
  const npm = ok([], [lv('Set-Location', '..', W, 'npm')]);
  expectAll('powershell', [
    ['cd ..; ls | % { npm i }', npm],
    ['cd ..; ls | ForEach-Object { npm i }', npm],
    ['cd ..; & { npm i }', npm],
    ["cd ..; iex 'npm i'", npm],
    ['cd ..; ls | % { ls }', NONE],
    ['cd ..; ls | foreach { ls }', NONE],
    ['cd ..; & { ls }', NONE],
    ["cd ..; iex 'ls'", NONE],
    ["cd ..; Invoke-Expression 'ls'", NONE],
  ]);
});

test('FS-48 §7.7 Set-Location and Push-Location parameters, Pop-Location, cd + and samePath', () => {
  expectAll('powershell', [
    ['cd ..; Out-File a; Set-Location -Path ..; Out-File b; Set-Location -LiteralPath C:\\w\\proj; npm i', ok(
      [wr('Out-File', 'a', w('a')), wr('Out-File', 'b', 'C:\\b')],
      [lv('Set-Location', '..', W, 'Out-File'), lv('Set-Location', '..', 'C:\\', 'Out-File')],
    )],
    ['Set-Location -PassThru ..; npm i; chdir proj; npm i', ok([], [lv('Set-Location', '..', W, 'npm')])],
    ['Set-Location ..\\x -StackName s; npm i', ok([], [lv('Set-Location', '..\\x', w('x'), 'npm')])],
    ['Push-Location -StackName s ..; npm i', ok([], [lv('Push-Location', '..', W, 'npm')])],
    ['cd +; npm i', ok([], [lv('Set-Location', '+', null, 'npm')])],
    ['Push-Location ..; Pop-Location; npm i', NONE],
    ['cd ..\\PROJ; npm i; sl ..\\proj\\.; npm i', NONE],
    ['popd; npm i', (result) => assert.deepEqual(leavesOf(result).map((l) => [l.form, l.dir, l.command]),
      [['Pop-Location', null, 'npm']])],
  ]);
});

test('FS-48 §17 location functions cd.., cd\\, cd~ and drive letters', () => {
  expectAll('powershell', [
    ['cd..; npm i', ok([], [lv('Set-Location', '..', W, 'npm')])],
    ['cd\\; npm i', ok([], [lv('Set-Location', '\\', 'C:\\', 'npm')])],
    ['cd~; npm i', ok([], [lv('Set-Location', '~', null, 'npm')])],
    ['C:; npm i', NONE],
    ['c:; Out-File a', ok([wr('Out-File', 'a', p('a'))])],
    ['D:; npm i', ok([], [lv('Set-Location', 'D:', null, 'npm')])],
  ]);
});

test('FS-48 §17 piped Push-Location / Set-Location and -StackName make the location unknown', () => {
  expectAll('powershell', [
    ["'..' | Push-Location; npm i", ok([], [lv('Push-Location', '(paths from input)', null, 'npm')])],
    ["'..' | Set-Location; npm i", ok([], [lv('Set-Location', '(paths from input)', null, 'npm')])],
    ['Push-Location -StackName s ..; Pop-Location; npm i', (result) => assert.deepEqual(
      leavesOf(result).map((l) => [l.form, l.dir, l.command]), [['Pop-Location', null, 'npm']])],
    ['Push-Location .\\src -StackName s; Pop-Location -StackName s; npm i', (result) => assert.deepEqual(
      leavesOf(result).map((l) => [l.form, l.dir, l.command]), [['Pop-Location', null, 'npm']])],
  ]);
});

test('FS-48 §17 PowerShell branches and loop bodies', () => {
  const branches = scan('powershell', 'if ($a) { cd .. } else { cd sub }; npm i');
  sameSet(leavesOf(branches), [lv('Set-Location', '..', W, 'npm'), lv('Set-Location', 'sub', p('sub'), 'npm')]);
  const orList = scan('powershell', 'npm i || cd ..; npm i');
  assert.deepEqual(leavesOf(orList), [lv('Set-Location', '..', W, 'npm')]);
  expectAll('powershell', [
    ['foreach ($d in $x) { npm i; cd .. }', ok([], [lv('Set-Location', '..', null, 'npm')])],
    ['for ($i=0; $i -lt 2; $i++) { Out-File a; cd .. }', ok(
      [wr('Out-File', 'a', p('a')), wq('Out-File', 'a', 'directory')], [lv('Set-Location', '..', null, 'Out-File')],
    )],
    ['do { npm i; cd .. } while ($x)', ok([], [lv('Set-Location', '..', null, 'npm')])],
    ['foreach ($d in $x) { npm i }', NONE],
  ]);
  const loop = scan('powershell', 'while ($true) { cd ..; npm i }');
  sameSet(leavesOf(loop), [lv('Set-Location', '..', W, 'npm'), lv('Set-Location', '..', null, 'npm')]);
  const cases = leavesOf(scan('powershell', 'switch ($x) { a { cd .. } b { cd sub } }; npm i'));
  assert.ok(cases.some((l) => l.dir === W) && cases.some((l) => l.dir === null), JSON.stringify(cases));
});

test('FS-48 §7.7 git directories in PowerShell: -C, --git-dir, --work-tree, $env:GIT_WORK_TREE, $env:GIT_DIR', () => {
  expectAll('powershell', [
    ['git -C ..\\x commit; git --work-tree=.. add .', ok([], [
      lv('git -C', '..\\x', w('x'), 'git commit'), lv('--work-tree', '..', W, 'git add'),
    ])],
    [String.raw`git --git-dir=..\o\.git commit`, ok([], [
      lv('--git-dir', '..\\o\\.git', w('o', '.git'), 'git commit'),
    ])],
    [String.raw`git --git-dir ..\o\.git log; git --git-dir ..\o\.git reset --hard`, ok([], [
      lv('--git-dir', '..\\o\\.git', w('o', '.git'), 'git reset'),
    ])],
    ["$env:GIT_WORK_TREE = '..'; git add -A; git status", ok([], [lv('GIT_WORK_TREE', '..', W, 'git add')])],
    // 之前设过的 $env:GIT_DIR 相对 -C 之后的目录解析（同 git：先换 -C）；
    // 同一次 git 调用的几条 leave 谁先谁后规格没定，按集合比较
    [String.raw`$env:GIT_DIR = 'o\.git'; git -C .. commit`, okAnyOrder([], [
      lv('git -C', '..', W, 'git commit'), lv('GIT_DIR', 'o\\.git', w('o', '.git'), 'git commit'),
    ])],
    ['git -C .. diff > d.patch', ok([wr('>', 'd.patch', p('d.patch'))])],
  ]);
});

// ---- FS-49：解析失败、上限、去重、纯函数与时间 ----

test('FS-49 §7.8 every reason that applies to PowerShell has a case', () => {
  expectAll('powershell', [
    ["Out-File 'abc", fail('unclosed quote')],
    ['Out-File "abc', fail('unclosed quote')],
    ["@'\nabc", fail('unclosed quote')],
    ['@"\nabc', fail('unclosed quote')],
    ['Out-File (Get-Date', fail('unclosed bracket')],
    ['ls | % { ni a', fail('unclosed bracket')],
    ['Out-File ${env:TEMP', fail('unclosed bracket')],
    ['$a = @(1, 2', fail('unclosed bracket')],
    ['$h = @{ a = 1', fail('unclosed bracket')],
    ['Out-File $(Get-Date', fail('unclosed command substitution')],
    ['& $exe build', fail(NAME_FAIL)],
    ['iex $s', fail(TEXT_FAIL)],
    ['powershell -EncodedCommand ZQBj', fail('encoded command')],
    ['pwsh -WorkingDirectory .. -c x', fail('unsupported option -WorkingDirectory')],
    ['Get-Content < in.txt', fail('PowerShell has no < redirection')],
    ['npm run build --% > ..\\x', fail('stop-parsing token')],
    ["npm run build '>' ..\\x", fail('cmd.exe metacharacter in an argument')],
    [nested(33), fail('nested too deeply')],
    [`Write-Output ${'a'.repeat(scanModule.SCAN_MAX_CHARS)}`, fail('the command is too long')],
  ]);
});

test('FS-49 §7.8 PowerShell nesting: 32 levels are analyzed, 33 fail', () => {
  assert.deepEqual(scan('powershell', nested(32)), NONE);
  assert.deepEqual(scan('powershell', nested(33)), fail('nested too deeply'));
  assert.deepEqual(scan('powershell', `${'& { '.repeat(33)}ni a${' }'.repeat(33)}`), fail('nested too deeply'));
  assert.deepEqual(scan('powershell', `${'( '.repeat(33)}1${' )'.repeat(33)}`), fail('nested too deeply'));
  // §17（2026-10-27）：PowerShell 赋值的右边同样算一层
  assert.deepEqual(scan('powershell', `${'$a = '.repeat(10)}(ni x)`), ok([wr('New-Item', 'x', p('x'))]));
  assert.deepEqual(scan('powershell', `${'$a = '.repeat(40)}1`), fail('nested too deeply'));
});

test('FS-49 PowerShell duplicates (B117) keep the first; unrecognized parameters are not merged (S20)', () => {
  expectAll('powershell', [
    ['ni a; New-Item a; ni .\\a', ok([wr('New-Item', 'a', p('a')), wr('New-Item', '.\\a', p('a'))])],
    ['Out-File $o; Out-File $o', ok([wq('Out-File', '$o', 'variable')])],
    ['cd ..; npm i; cd proj; cd ..; npm i', ok([], [lv('Set-Location', '..', W, 'npm')])],
    ['cd ..; npm i; cd ..; npm i', ok([], [
      lv('Set-Location', '..', W, 'npm'), lv('Set-Location', '..', 'C:\\', 'npm'),
    ])],
  ]);
});

/** 纯函数检查用的命令：用到 $env:TEMP、~、$HOME、以 \ 开头的路径与相对路径 */
const PURE_COMMANDS = [
  'Out-File $env:TEMP\\a; Out-File ~\\b; Out-File $HOME\\c; Out-File \\d; Out-File e; Out-File $PWD\\f',
  'cd ..; npm i > log; git -C sub commit; Out-File \\\\srv\\s\\x',
];

test('FS-49 PowerShell results are the same after process.env.TEMP, HOME and the current directory change',
  (context) => {
    const before = PURE_COMMANDS.map((command) => scan('powershell', command));
    const saved = { TEMP: process.env.TEMP, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
      cwd: process.cwd() };
    const elsewhere = tmpdir();
    context.after(() => {
      for (const name of ['TEMP', 'HOME', 'USERPROFILE']) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
      process.chdir(saved.cwd);
    });
    process.env.TEMP = 'D:\\elsewhere\\temp';
    process.env.HOME = 'D:\\elsewhere\\home';
    process.env.USERPROFILE = 'D:\\elsewhere\\profile';
    process.chdir(elsewhere);
    assert.notEqual(process.cwd(), saved.cwd);
    assert.deepEqual(PURE_COMMANDS.map((command) => scan('powershell', command)), before);
    assert.deepEqual(writesOf(before[0]).map((x) => x.path), [t('a'), null, null, 'C:\\d', p('e'), p('f')]);
  });

/** FS-49 计时用的 1 MB PowerShell 命令（几种形状） */
const MEGABYTE_SHAPES = [
  ['short statements', () => megabyte('Get-ChildItem; ')],
  ['pipelines with script blocks', () => megabyte('Get-ChildItem | Where-Object { $_.Length -gt 1 } | Out-Null; ')],
  ['a long here-string', () => megabyte('line of text\n', "@'\n", "\n'@ | Out-Null")],
  ['one long word', () => megabyte('a', 'Write-Output ')],
  ['Set-Location and a command', () => megabyte('cd ..; npm i; ')],
  ['if blocks and assignments', () => megabyte('if ($a) { $b = Get-Date } else { Write-Output "x $c" }; ')],
];

test('FS-49 a 1 MB PowerShell command is analyzed in at most 500 ms', () => {
  timeShapes('powershell', MEGABYTE_SHAPES, 'Get-ChildItem; cd ..; npm i > x; if ($a) { b }');
});

// ---- FS-50：git 自己的写入不算 ----

test('FS-50 PowerShell: git subcommands never appear in writes; the main folder of a worktree is a leave', () => {
  const cases = ['commit -am x', 'add -A', 'checkout main', 'merge b', 'reset --hard', 'worktree add ..\\w',
    'clone u x', 'stash', 'clean -fd'].map((sub) => [`git ${sub}`, NONE]);
  expectAll('powershell', cases);
  expectAll('powershell', cases, WORKTREE);
  assert.deepEqual(scan('powershell', 'git commit -am x; git -C ..\\..\\.. merge mori/a', WORKTREE),
    ok([], [lv('git -C', '..\\..\\..', 'C:\\r', 'git merge')]));
  assert.deepEqual(scan('powershell', 'git log > ..\\l.txt; Remove-Item -Recurse .git'), ok([
    wr('>', '..\\l.txt', w('l.txt')), wr('Remove-Item', '.git', p('.git'), DEL),
  ]));
});
