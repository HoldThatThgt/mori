// 路径闸的纯函数（docs/specs/file-system-permissions.md §6.3–§6.5、§6.9、§6.13；验收 file-system.md §19.2 FS-27、
// FS-28、FS-29、FS-41）：resolveToCwd 与 insideDir 和 pi 1.3.0 按文件路径载入的实现逐个比较；四种归类与受保护名单的
// 每一行；目录联接（fs.symlinkSync(…, 'junction')，不要管理员权限）与注入计数的 lstat / realpath；目标上限。
// 临时目录里的项目、联接与命令都是测试写的（synthetic）。

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadKernelModule } from '../load.mjs';
import { countingProbe, quietlySync, tempProject } from './gate-helpers.mjs';

const G = await loadKernelModule('src/kernel/pathGate.ts');
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const piDist = join(appRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist');
/** pi 的 resolveToCwd（包没有导出 path-utils，测试按文件路径 import） */
const piTools = await import(pathToFileURL(join(piDist, 'core', 'tools', 'path-utils.js')).href);
/** pi 的 getCwdRelativePath */
const piPaths = await import(pathToFileURL(join(piDist, 'utils', 'paths.js')).href);

const project = tempProject('mori-fs-gate-');
const { root, cwd } = project;
after(() => project.remove());

/** @brief 分类一个调用（截下 realTarget 的日志）。 */
function classify(toolName, input, at = cwd, fsx) {
  return quietlySync(() => G.classifyCall(toolName, input, at, fsx)).value;
}

/** @brief write 工具写 path 时唯一目标的归类。 */
function writeClass(path, at = cwd) {
  const call = classify('write', { path, content: 'x' }, at);
  assert.equal(call.targets.length, 1, `one target for ${path}`);
  return call.targets[0].cls;
}

/** @brief bash 命令的目标归类（按顺序）与 scope。 */
function bashOf(command, at = cwd) {
  const call = classify('bash', { command }, at);
  return { classes: call.targets.map((target) => target.cls), scope: call.scope, call };
}

// ---- FS-27 路径解析与 pi 一致 ----

/** §19.2 FS-27 列出的写法（相对、..、@、/c/…、/mnt/d/…、/cygdrive/c/…、~、~/、~\、file://、特殊空格、\rooted、C:rel、UNC） */
const RESOLVE_INPUTS = [
  'a.txt', 'src/a.ts', 'src\\a.ts', './a', '.', '', 'a//b', 'a\\.\\b', '...', '..notes',
  '..', '../x', '..\\x', 'a/../../b', 'src/../..',
  '@a.txt', '@../x', '@/c/w/x', '@~/x', '@@a', '\u00A0@a',
  '/c/x/y', '/C/x', '/c', '/c/', '/mnt/d/data/x', '/mnt/c', '/cygdrive/c/x', '/cygdrive/D/x/y', '/c\\x', '//c/x',
  '/tmp/x', '/usr/bin', '/cd/x',
  '~', '~/', '~/x', '~\\x', '~\\', '~user/x', 'a/~/b',
  'file:///C:/w/x.txt', 'file:///c:/w/a%20b.txt', 'file://server/share/x',
  'a\u00A0b.txt', 'x\u2003y', '\u3000a', 'a\u202Fb', 'a\u205Fb', 'a\u2000b', 'a\u200Ab', 'a\u200Bb',
  '\\rooted\\x', '\\x', '/x/y', 'C:rel', 'C:', 'D:rel\\x', 'C:\\abs\\x', 'C:/abs/x', 'c:\\Abs\\..\\y',
  '\\\\server\\share\\x', '\\\\server\\share', '//server/share/x',
];
/** 工作目录的几种写法（pi 对 baseDir 只做 /c/…、~、file:// 三步） */
const RESOLVE_CWDS = ['C:\\w\\proj', 'D:\\shop', 'C:\\w\\proj\\', '/c/w/proj', 'C:/w/proj', '~',
  'file:///C:/w/proj', '\\\\server\\share\\proj'];

test('FS-27 resolveToCwd equals pi 1.3.0 path-utils resolveToCwd for every listed input and working directory', () => {
  for (const at of RESOLVE_CWDS) {
    for (const input of RESOLVE_INPUTS) {
      assert.equal(G.resolveToCwd(input, at), piTools.resolveToCwd(input, at),
        `resolveToCwd(${JSON.stringify(input)}, ${JSON.stringify(at)})`);
    }
  }
});

/** (目录, 目标)：含 ..notes 这种名字、..、..\x、前缀相同的兄弟目录、大小写与分隔符、别的盘与 UNC */
const INSIDE_PAIRS = [
  ['C:\\w\\proj', 'C:\\w\\proj'], ['C:\\w\\proj', 'C:\\w\\proj\\a'], ['C:\\w\\proj', 'C:\\w\\proj\\..notes'],
  ['C:\\w\\proj', 'C:\\w\\proj\\..notes\\x'], ['C:\\w\\proj', 'C:\\w\\proj\\...'], ['C:\\w\\proj', 'C:\\w\\proj\\..'],
  ['C:\\w\\proj', 'C:\\w\\proj\\..\\x'], ['C:\\w\\proj', 'C:\\w'], ['C:\\w\\proj', 'C:\\w\\proj-x\\a'],
  ['C:\\w\\proj', 'C:\\w\\proj-x'], ['C:\\w\\proj', 'c:\\W\\PROJ\\a'], ['C:\\w\\proj', 'C:/w/proj/a'],
  ['C:\\w\\proj', 'D:\\w\\proj\\a'], ['C:\\w\\proj', '\\\\server\\share\\a'], ['C:\\w\\proj\\', 'C:\\w\\proj\\a'],
  ['C:\\', 'C:\\x'], ['C:\\w\\proj', 'C:\\w\\proj\\a\\..\\..\\proj\\b'], ['C:\\w\\proj', 'C:\\w\\projects\\a'],
  ['\\\\server\\share\\proj', '\\\\server\\share\\proj\\a'], ['\\\\server\\share\\proj', '\\\\server\\share\\other'],
];

test('FS-27 insideDir agrees with pi getCwdRelativePath on inside or not: ..notes inside, .. and ..\\x outside', () => {
  for (const [dir, target] of INSIDE_PAIRS) {
    const pi = piPaths.getCwdRelativePath(target, dir) !== undefined;
    assert.equal(G.insideDir(dir, target), pi, `insideDir(${dir}, ${target})`);
  }
  assert.equal(G.insideDir('C:\\w\\proj', 'C:\\w\\proj\\..notes'), true);
  assert.equal(G.insideDir('C:\\w\\proj', 'C:\\w'), false);
  assert.equal(G.insideDir('C:\\w\\proj', 'C:\\w\\x'), false);
  assert.equal(G.insideDir('C:\\w\\proj', 'C:\\w\\proj-x'), false);
});

// ---- FS-28 四种归类与名单 ----

/** §6.5 的目录（.config/git 另测） */
const SPEC_DIRS = ['.git', '.vscode', '.idea', '.husky', '.cargo', '.devcontainer', '.yarn', '.mvn', '.claude', '.mori',
  '.pi'];
/** §6.5 的文件 */
const SPEC_FILES = ['.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.bash_login', '.bash_aliases',
  '.bash_logout', '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout', '.profile', '.envrc', '.npmrc', '.yarnrc',
  '.yarnrc.yml', '.pnp.cjs', '.pnp.loader.mjs', '.pnpmfile.cjs', 'bunfig.toml', '.bunfig.toml', '.bazelrc',
  '.bazelversion', '.bazeliskrc', '.pre-commit-config.yaml', 'lefthook.yml', 'lefthook.yaml', '.lefthook.yml',
  '.lefthook.yaml', 'gradle-wrapper.properties', 'maven-wrapper.properties', '.devcontainer.json', '.ripgreprc',
  'pyrightconfig.json', '.mcp.json', '.claude.json'];

test('FS-28 the protected lists in pathGate.ts are exactly the §6.5 lists', () => {
  assert.deepEqual([...G.PROTECTED_DIRS].sort(), [...SPEC_DIRS, '.config/git'].sort());
  assert.deepEqual([...G.PROTECTED_FILES].sort(), [...SPEC_FILES].sort());
});

test('FS-28 inside: an ordinary file, a new nested file and the working directory itself (cp a.txt .)', () => {
  assert.equal(writeClass('a.txt'), 'inside');
  assert.equal(writeClass('src/deep/new/b.ts'), 'inside');
  assert.equal(writeClass('src/.work/a.txt'), 'inside', '.work only counts as the first segment');
  assert.equal(writeClass('src/../c.md'), 'inside');
  assert.deepEqual(bashOf('cp a.txt .').classes, ['inside']);
  assert.deepEqual(bashOf('mkdir -p .').classes, ['inside']);
  assert.equal(bashOf('cp a.txt .').scope, 'inside');
});

test('FS-28 work: .work and everything under it, before the protected list (.work/x/.git/config)', () => {
  for (const path of ['.work/n.md', '.work/x/.git/config', '.work/.git/hooks/pre-commit', '.work/.npmrc', '.work',
    '.WORK/a.txt', '.work./a.txt', '.work /a.txt', '.work::$INDEX_ALLOCATION/a.txt', '.work\\tmp\\x']) {
    assert.equal(writeClass(path), 'work', path);
  }
  const call = classify('write', { path: '.work/x/.git/config' });
  assert.equal(call.scope, 'inside');
});

/** @brief 一个名字的写法：原样、全大写、末尾带 . 或空格、带流名。 */
function variants(name) {
  return [name, name.toUpperCase(), `${name}.`, `${name} `, `${name}. .`, `${name}:stream`, `${name}::$DATA`];
}

for (const dir of SPEC_DIRS) {
  test(`FS-28 protected directory ${dir}: any segment, any case, trailing dot or space, stream name`, () => {
    for (const name of [...variants(dir), `${dir}::$INDEX_ALLOCATION`]) {
      for (const path of [`${name}/x`, `src/${name}/x`, `a/b/${name}`, name]) {
        assert.equal(writeClass(path), 'protected', path);
      }
    }
    assert.equal(writeClass(`${dir}x/a`), 'inside', `${dir}x is another name`);
    assert.equal(writeClass(`x${dir}/a`), 'inside', `x${dir} is another name`);
  });
}

for (const file of SPEC_FILES) {
  test(`FS-28 protected file ${file}: the last segment, any case, trailing dot or space, stream name`, () => {
    for (const name of variants(file)) {
      for (const path of [name, `src/${name}`, `a/b/c/${name}`]) assert.equal(writeClass(path), 'protected', path);
    }
    assert.equal(writeClass(`${file}/x`), 'inside', 'a file name only counts as the last segment');
    assert.equal(writeClass(`${file}.bak`), 'inside');
  });
}

test('FS-28 .config/git: two consecutive segments, any case; .config or git alone is not protected', () => {
  for (const path of ['.config/git/config', '.config/git', 'a/.config/git/ignore', '.CONFIG/Git/x', '.config./git /x',
    '.config:s/git/x']) {
    assert.equal(writeClass(path), 'protected', path);
  }
  for (const path of ['.config/x', '.config', 'git/x', '.config/a/git', '.config/gitx/a', 'git/.config/x']) {
    assert.equal(writeClass(path), 'inside', path);
  }
});

test('FS-28 removing the working directory or a parent is protected; writing into it is not', () => {
  for (const command of ['rm -rf .', 'rm -rf ..', 'rm -rf ../..', 'rmdir .', `rm -rf '${cwd}'`, `rm -rf '${root}'`,
    `rm -rf '${parse(cwd).root}'`, 'mv ../proj ../old', 'mv . ../old']) {
    const { classes, scope } = bashOf(command);
    assert.equal(classes[0], 'protected', command);
    assert.equal(scope, 'protected', command);
  }
  const ps = classify('powershell', { command: 'Remove-Item -Recurse ..' });
  assert.deepEqual([ps.targets.map((target) => target.cls), ps.scope], [['protected'], 'protected']);
  assert.deepEqual(bashOf('mv ../proj ../old').classes, ['protected', 'outside']);
  assert.deepEqual(bashOf('rm -rf ./src').classes, ['inside'], 'removing a folder inside is an inside write');
  assert.deepEqual(bashOf('cp a.txt ..').classes, ['outside'], '.. written into (not removed) is outside');
  assert.deepEqual(bashOf('cp a.txt .').classes, ['inside']);
  const removed = bashOf('rm -rf .').call.targets[0];
  assert.equal(removed.path, cwd, 'the request carries the working directory itself');
});

test('FS-28 outside: a sibling folder with the same prefix, a parent file, another drive and a UNC path', () => {
  assert.equal(writeClass(`${cwd}-x\\a.txt`), 'outside');
  assert.equal(writeClass('../proj-x/a.txt'), 'outside');
  assert.equal(writeClass('../notes.md'), 'outside');
  assert.equal(writeClass('\\\\server\\share\\x.txt'), 'outside');
  const call = classify('write', { path: '..\\notes.md' });
  assert.equal(call.scope, 'outside');
  assert.deepEqual(G.approvalTargets(call),
    [{ reason: 'outside', path: join(root, 'notes.md'), text: '..\\notes.md' }]);
});

test('FS-28 outside paths that hit the list are protected (.gitconfig, another repository\'s .git\\hooks)', () => {
  assert.equal(writeClass('../.gitconfig'), 'protected');
  assert.equal(writeClass(`${root}\\repo\\.git\\hooks\\pre-commit`), 'protected');
  assert.equal(writeClass(`${root}\\home\\.bashrc`), 'protected');
  const call = classify('write', { path: '../.gitconfig' });
  assert.deepEqual(G.approvalTargets(call), [{ reason: 'protected', path: join(root, '.gitconfig'),
    text: '../.gitconfig' }]);
  assert.deepEqual(G.allowDirsOf(call), [], 'protected paths are never allowed by folder');
});

test('FS-28 a working directory inside .cargo: its own writes compare only the segments below it', () => {
  const at = join(root, '.cargo', 'proj');
  mkdirSync(at, { recursive: true });
  assert.equal(writeClass('src/main.rs', at), 'inside');
  assert.equal(writeClass('.git/config', at), 'protected');
  assert.equal(writeClass('../registry/x', at), 'protected', 'outside, and the full path has .cargo');
});

test('FS-28 a worktree working directory: its src is inside, the main folder outside, .mori there protected', () => {
  const main = join(root, 'main');
  const at = join(main, '.mori', 'worktrees', 'x');
  mkdirSync(join(at, 'src'), { recursive: true });
  mkdirSync(join(main, '.mori', 'worktrees', 'y'), { recursive: true });
  assert.equal(writeClass('src/a.ts', at), 'inside');
  assert.equal(writeClass(join(main, 'src', 'a.ts'), at), 'outside');
  assert.equal(writeClass('../../../src/a.ts', at), 'outside');
  assert.equal(writeClass(join(main, '.mori', 'agents', 'a.md'), at), 'protected');
  assert.equal(writeClass('../y/a.ts', at), 'protected', 'another worktree');
  assert.equal(writeClass(join(main, '.mori', 'worktrees', 'y', 'src', 'b.ts'), at), 'protected');
});

test('FS-28 a leave whose directory is inside the working directory is dropped (cd src, cd .git, cd .work)', () => {
  for (const command of ['cd src && npm i', 'cd .git && npm i', 'cd .work && npm i', 'cd src/.. && make',
    `cd '${cwd}' && npm i`]) {
    const { classes, scope } = bashOf(command);
    assert.deepEqual([classes, scope], [[], 'inside'], command);
  }
  const out = bashOf('cd .. && npm i');
  assert.deepEqual([out.classes, out.scope], [['leaves'], 'outside']);
  assert.deepEqual(G.approvalTargets(out.call), [{ reason: 'leaves', path: root, text: '..' }]);
  const unknown = bashOf('cd $SOMEWHERE && npm i');
  assert.deepEqual(G.approvalTargets(unknown.call), [{ reason: 'leaves', path: null, text: '$SOMEWHERE' }]);
});

test('FS-28 unresolved and unanalyzed targets: path null, scope outside, and they carry the text', () => {
  const unresolved = bashOf('echo x > $OUT/a.log');
  assert.deepEqual(G.approvalTargets(unresolved.call), [{ reason: 'unresolved', path: null, text: '$OUT/a.log' }]);
  assert.equal(unresolved.scope, 'outside');
  const failed = bashOf('echo "abc');
  assert.deepEqual(G.approvalTargets(failed.call), [{ reason: 'unanalyzed', path: null, text: 'unclosed quote' }]);
  assert.equal(failed.scope, 'outside');
});

test('FS-28 request targets (§6.13): the writes keep command order among themselves, and so do the leaves', () => {
  // 写入与 leaves 交错时两者之间的先后（§6.13 与 §7.2 的 ScanResult 不一致）留给集成方定，这里只比各自的顺序；
  // 子 shell 里的 cd 不带出来，后面的 ../o2.txt 仍按工作路径解析
  const { call } = bashOf('echo 1 > ../o1.txt; (cd .. && npm i); echo 2 > ../o2.txt; (cd ../far && npm i)');
  const of = (reason) => G.approvalTargets(call).filter((target) => target.reason === reason);
  assert.deepEqual(of('outside'), [{ reason: 'outside', path: join(root, 'o1.txt'), text: '../o1.txt' },
    { reason: 'outside', path: join(root, 'o2.txt'), text: '../o2.txt' }]);
  assert.deepEqual(of('leaves'), [{ reason: 'leaves', path: root, text: '..' },
    { reason: 'leaves', path: join(root, 'far'), text: '../far' }]);
  assert.equal(G.approvalTargets(call).length, 4);
});

test('FS-28 scope: protected wins over outside; read, other and commands without writes are inside', () => {
  assert.equal(bashOf('echo a > ../o.txt; echo b > .git/config').scope, 'protected');
  assert.equal(bashOf('echo a > ../o.txt; echo b > $X').scope, 'outside');
  assert.equal(bashOf('npm test').scope, 'inside');
  assert.equal(bashOf('echo x > .work/a.txt').scope, 'inside');
  for (const [toolName, input] of [['read', { path: '../x' }], ['grep', { pattern: 'a', path: 'C:\\' }],
    ['mcp__srv__tool', { path: '../x' }], ['deploy_check', {}], ['edit', {}], ['write', { path: 3 }],
    ['bash', {}]]) {
    const call = classify(toolName, input);
    assert.deepEqual([call.targets, call.scope], [[], 'inside'], toolName);
    assert.deepEqual(G.approvalTargets(call), []);
  }
});

/** TaskBoard 的 11 个工具（§6.1 第 1 步，平行 Agent 规格） */
const TEAM_TOOLS = ['board_read', 'read_session', 'agent_message', 'task_handoff', 'request_submit', 'request_update',
  'request_cancel', 'task_create', 'task_edit', 'reply_via_dialog', 'request_close'];

test('FS-28 callKind: duty, read, file, command and other by tool name and argument shape', () => {
  for (const name of [...TEAM_TOOLS, 'memory', 'ask_user_question']) {
    assert.equal(G.callKind(name, {}), 'duty', name);
  }
  assert.equal(G.DUTY_TOOLS.size, 13);
  for (const name of ['read', 'grep', 'find', 'ls']) assert.equal(G.callKind(name, {}), 'read', name);
  assert.equal(G.callKind('edit', { path: 'a' }), 'file');
  assert.equal(G.callKind('write', { path: 'a' }), 'file');
  assert.equal(G.callKind('bash', { command: 'x' }), 'command');
  assert.equal(G.callKind('powershell', { command: 'x' }), 'command');
  assert.equal(G.callKind('edit', { file: 'a' }), 'other');
  assert.equal(G.callKind('bash', { command: ['x'] }), 'other');
  assert.equal(G.callKind('mcp__srv__tool', { path: 'a' }), 'other');
});

/**
 * @brief synthetic 的参数：第一次读 command（callKind 判断种类）给出 'npm test'，之后再读就抛错，
 *        让分类在 classifyCall 的 try 里出错。
 */
function failingInput() {
  let reads = 0;
  return {
    get command() {
      reads += 1;
      if (reads > 1) throw new Error('synthetic scan failure');
      return 'npm test';
    },
  };
}

test('FS-30 classifyCall catches a failure inside classification: logged, one unresolved target, scope outside', () => {
  const { value: call, errors } = quietlySync(() => G.classifyCall('bash', failingInput(), cwd));
  assert.equal(call.kind, 'command');
  assert.equal(call.scope, 'outside');
  assert.deepEqual(call.targets, [{ cls: 'unresolved', path: null, real: null, text: 'bash', remove: false,
    into: false }]);
  assert.deepEqual(errors, ['[kernel] path gate: synthetic scan failure']);
  assert.deepEqual(G.approvalTargets(call), [{ reason: 'unresolved', path: null, text: 'bash' }]);
  assert.deepEqual(G.allowDirsOf(call), []);
});

// ---- FS-29 链接 ----

/** @brief 在 at 建一个指向 target 的目录联接（不要管理员权限）。 */
function junction(target, at) {
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(target, at, 'junction');
}

/** 工作路径外的目录（联接指向它） */
const OUT = join(root, 'out');
mkdirSync(OUT, { recursive: true });

test('FS-29 a write under a junction inside that points outside is outside, with the real path in the request', () => {
  junction(OUT, join(cwd, 'link'));
  const call = classify('write', { path: 'link/a.txt' });
  assert.equal(call.targets[0].cls, 'outside');
  assert.deepEqual(G.approvalTargets(call), [{ reason: 'outside', path: join(OUT, 'a.txt'), text: 'link/a.txt' }]);
  assert.deepEqual(G.allowDirsOf(call), [OUT], 'the folder to allow is the real one');
  const deep = classify('write', { path: 'link/new/dir/b.txt' });
  assert.deepEqual(G.approvalTargets(deep)[0].path, join(OUT, 'new', 'dir', 'b.txt'));
});

test('FS-29 .work as a junction to a folder outside is outside, not work', () => {
  const at = join(root, 'w2');
  mkdirSync(at);
  mkdirSync(join(root, 'scratch'));
  junction(join(root, 'scratch'), join(at, '.work'));
  const call = classify('write', { path: '.work/n.md' }, at);
  assert.equal(call.targets[0].cls, 'outside');
  assert.equal(call.targets[0].path, join(root, 'scratch', 'n.md'));
});

test('FS-29 a write under a junction outside that points inside is outside, without touching the file system', () => {
  mkdirSync(join(cwd, 'sub'), { recursive: true });
  junction(join(cwd, 'sub'), join(OUT, 'into'));
  const { probe, calls } = countingProbe();
  const call = classify('write', { path: join(OUT, 'into', 'a.txt') }, cwd, probe);
  assert.equal(call.targets[0].cls, 'outside');
  assert.equal(call.targets[0].path, join(OUT, 'into', 'a.txt'));
  assert.deepEqual(calls, []);
});

test('FS-29 the request names the lexical path when only it hits the list, the real one when that hits', () => {
  const at = join(root, 'w3');
  mkdirSync(join(at, 'store'), { recursive: true });
  mkdirSync(join(at, 'real', '.git'), { recursive: true });
  junction(join(at, 'store'), join(at, '.git'));
  junction(join(at, 'real', '.git'), join(at, 'cfg'));
  const lexical = classify('write', { path: '.git/x' }, at);
  assert.deepEqual(G.approvalTargets(lexical), [{ reason: 'protected', path: join(at, '.git', 'x'), text: '.git/x' }]);
  const real = classify('write', { path: 'cfg/config' }, at);
  assert.deepEqual(G.approvalTargets(real), [{ reason: 'protected', path: join(at, 'real', '.git', 'config'),
    text: 'cfg/config' }]);
});

test('FS-29 a dangling junction is outside and logged', () => {
  mkdirSync(join(root, 'gone'));
  junction(join(root, 'gone'), join(cwd, 'dangling'));
  rmdirSync(join(root, 'gone'));
  const target = join(cwd, 'dangling', 'a.txt');
  const { value: call, errors } = quietlySync(() => G.classifyCall('write', { path: 'dangling/a.txt' }, cwd));
  assert.equal(call.targets[0].cls, 'outside');
  assert.equal(call.scope, 'outside');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].startsWith(`[kernel] path gate: cannot resolve ${target}: `), errors[0]);
});

test('FS-29 an injected lstat error other than ENOENT/ENOTDIR (EPERM) is outside and logged', () => {
  const target = join(cwd, 'locked', 'a.txt');
  const { probe } = countingProbe((op, path) => {
    if (op === 'lstat' && path === target) {
      throw Object.assign(new Error(`EPERM: operation not permitted, lstat '${path}'`), { code: 'EPERM' });
    }
    return undefined;
  });
  const { value: call, errors } = quietlySync(() => G.classifyCall('write', { path: 'locked/a.txt' }, cwd, probe));
  assert.equal(call.targets[0].cls, 'outside');
  assert.deepEqual(errors, [`[kernel] path gate: cannot resolve ${target}: EPERM: operation not permitted, lstat `
    + `'${target}'`]);
});

test('FS-29 an injected realpath failure (ELOOP) is outside and logged', () => {
  const { probe } = countingProbe((op, path) => {
    if (op === 'realpath' && path !== cwd) throw Object.assign(new Error('ELOOP: loop'), { code: 'ELOOP' });
    return undefined;
  });
  writeFileSync(join(cwd, 'looped.txt'), 'x');
  const { value: call, errors } = quietlySync(() => G.classifyCall('write', { path: 'looped.txt' }, cwd, probe));
  assert.equal(call.targets[0].cls, 'outside');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^\[kernel\] path gate: cannot resolve .*looped\.txt: ELOOP: loop$/);
});

test('FS-29 lexically outside targets (UNC included) make no lstat or realpath calls', () => {
  const unc = '\\\\server\\share\\x.txt';
  for (const [toolName, input] of [['write', { path: unc }], ['write', { path: '..\\x.txt' }],
    ['edit', { path: join(OUT, 'y.txt') }], ['bash', { command: `echo x > '${unc}'` }],
    ['bash', { command: 'cp a ../b; tee ../c < a' }], ['bash', { command: 'cd //server/share && npm i' }],
    ['bash', { command: `cd '${OUT}' && npm i` }]]) {
    const { probe, calls } = countingProbe();
    const call = classify(toolName, input, cwd, probe);
    assert.notEqual(call.scope, 'inside', toolName);
    assert.deepEqual(calls, [], `${toolName} ${JSON.stringify(input)}`);
  }
});

test('FS-29 an inside target next to a lexically outside one: only the working directory and the inside target', () => {
  // 里面的目标是还没有的文件：lstat 它（ENOENT）后退到最近的已有上级，也就是工作路径
  const inside = join(cwd, 'fs29-mixed.txt');
  const cases = [
    [`echo a > fs29-mixed.txt; echo b > '\\\\server\\share\\x'`, ['inside', 'outside']],
    ['echo b > ../far.txt; echo a > fs29-mixed.txt', ['outside', 'inside']],
    [`echo a > fs29-mixed.txt; tee '${join(OUT, 'y.txt')}' < a`, ['inside', 'outside']],
    ['echo a > fs29-mixed.txt; cd //server/share && npm i', ['inside', 'leaves']],
  ];
  for (const [command, classes] of cases) {
    const { probe, calls } = countingProbe();
    const call = classify('bash', { command }, cwd, probe);
    assert.deepEqual([call.targets.map((target) => target.cls), call.scope], [classes, 'outside'], command);
    const seen = `${command}: ${JSON.stringify(calls)}`;
    assert.ok(calls.every(([, path]) => !path.startsWith('\\\\server')), `${seen}: the UNC target is never touched`);
    assert.ok(calls.every(([, path]) => path === cwd || path === inside), `${seen}: only the cwd and inside target`);
    assert.ok(calls.some(([op, path]) => op === 'lstat' && path === inside), `${seen}: the inside target is looked up`);
  }
});

test('FS-29 removing a lexically outside target resolves only the working directory, never the target', () => {
  for (const command of ['rm -rf ../other', `rm -rf '\\\\server\\share\\x'`, `rmdir '${OUT}'`]) {
    const { probe, calls } = countingProbe();
    const call = classify('bash', { command }, cwd, probe);
    assert.equal(call.scope, 'outside', command);
    assert.deepEqual(calls, [['lstat', cwd], ['realpath', cwd]], command);
  }
});

test('FS-29 several targets in one call take the real working directory once; each target one realpath', () => {
  for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(cwd, name), 'x');
  const { probe, calls } = countingProbe();
  const call = classify('bash', { command: 'touch a.txt b.txt c.txt; echo x > d/e/f.txt' }, cwd, probe);
  assert.deepEqual(call.targets.map((target) => target.cls), ['inside', 'inside', 'inside', 'inside']);
  const realpaths = calls.filter(([op]) => op === 'realpath').map(([, path]) => path);
  assert.deepEqual(realpaths, [cwd, join(cwd, 'a.txt'), join(cwd, 'b.txt'), join(cwd, 'c.txt'), cwd]);
  const deep = calls.filter(([op, path]) => op === 'lstat' && path.startsWith(join(cwd, 'd')));
  assert.equal(deep.length, 3, 'at most one lstat per segment of the missing part');
});

test('FS-29 a working directory opened through a junction: removing its real folder or parent is protected', () => {
  const real = join(root, 'real', 'proj2');
  mkdirSync(real, { recursive: true });
  const at = join(root, 'jproj');
  junction(real, at);
  for (const command of [`rm -rf '${join(root, 'real')}'`, 'rm -rf ../real/proj2', `rmdir '${real}'`]) {
    const { probe, calls } = countingProbe();
    const call = classify('bash', { command }, at, probe);
    assert.deepEqual([call.targets.map((target) => target.cls), call.scope], [['protected'], 'protected'], command);
    assert.deepEqual(calls, [['lstat', at], ['realpath', at]], `${command}: only the working directory is resolved`);
  }
  assert.equal(writeClass(join(real, 'a.txt'), at), 'outside', 'a link from outside back inside asks as outside');
  assert.equal(writeClass('a.txt', at), 'inside');
});

test('FS-29 lexically inside but really outside: the full paths are checked against the list', () => {
  const at = join(root, 'w4');
  mkdirSync(at);
  mkdirSync(join(root, '.cargo', 'reg'), { recursive: true });
  mkdirSync(join(root, 'gitstore'));
  junction(join(root, '.cargo', 'reg'), join(at, 'deps'));
  junction(join(root, 'gitstore'), join(at, '.git'));
  const viaReal = classify('write', { path: 'deps/a.rs' }, at);
  assert.deepEqual(G.approvalTargets(viaReal), [{ reason: 'protected', path: join(root, '.cargo', 'reg', 'a.rs'),
    text: 'deps/a.rs' }]);
  const viaLexical = classify('write', { path: '.git/config' }, at);
  assert.deepEqual(G.approvalTargets(viaLexical), [{ reason: 'protected', path: join(at, '.git', 'config'),
    text: '.git/config' }]);
});

test('FS-29 real paths are computed on every call, not cached', () => {
  assert.equal(writeClass('fresh/a.txt'), 'inside');
  junction(OUT, join(cwd, 'fresh'));
  assert.equal(writeClass('fresh/a.txt'), 'outside');
});

test('FS-29 cd into a junction pointing outside followed by npm i is a leave; cd src && npm i is dropped', () => {
  junction(OUT, join(cwd, 'outlink'));
  mkdirSync(join(cwd, 'src'), { recursive: true });
  const out = bashOf('cd outlink && npm i');
  assert.deepEqual([out.classes, out.scope], [['leaves'], 'outside']);
  assert.deepEqual(G.approvalTargets(out.call), [{ reason: 'leaves', path: OUT, text: 'outlink' }]);
  assert.deepEqual(bashOf('cd src && npm i').classes, []);
});

// ---- FS-41 目标上限 ----

/** @brief n 个 touch 的操作数：prefix + f1 … fn。 */
function names(prefix, n) {
  return Array.from({ length: n }, (_, i) => `${prefix}f${i + 1}`).join(' ');
}

test('FS-41 101 resolvable targets: the first 100 are resolved, the 101st is unresolved, scope outside', () => {
  const { probe, calls } = countingProbe();
  const call = classify('bash', { command: `touch ${names('', 101)}` }, cwd, probe);
  assert.equal(call.targets.length, 101);
  assert.ok(call.targets.slice(0, 100).every((target) => target.cls === 'inside'));
  assert.deepEqual(call.targets[100], { cls: 'unresolved', path: null, real: null, text: 'f101', remove: false,
    into: false });
  assert.equal(call.scope, 'outside');
  assert.deepEqual(G.approvalTargets(call), [{ reason: 'unresolved', path: null, text: 'f101' }]);
  assert.deepEqual(G.allowDirsOf(call), []);
  assert.ok(calls.every(([, path]) => !path.endsWith('f101')), 'the 101st target is never resolved');
});

test('FS-41 101 outside targets in one folder: allowDirs empty (no Allow writes to <folder>); 100 have it', () => {
  const over = classify('bash', { command: `touch ${names('../o/', 101)}` });
  assert.equal(over.scope, 'outside');
  assert.equal(over.targets.filter((target) => target.cls === 'outside').length, 100);
  assert.deepEqual(G.allowDirsOf(over), []);
  assert.equal(G.coveredByDirs(over, [join(root, 'o')]), false);
  const within = classify('bash', { command: `touch ${names('../o/', 100)}` });
  assert.deepEqual(G.allowDirsOf(within), [join(root, 'o')]);
});
